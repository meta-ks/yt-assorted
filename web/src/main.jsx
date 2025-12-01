import React, { useMemo, useState } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'

const emptySegment = () => ({ id: crypto.randomUUID(), url: '', start: '', end: '', error: '' })

const parseTimeParam = url => {
  const match = url.match(/[?&](?:t|start)=([^&#]+)/)
  if (!match) return null
  const raw = decodeURIComponent(match[1])
  if (/^\d+$/.test(raw)) return Number(raw)
  let total = 0
  const parts = raw.match(/(\d+)([hms])/g)
  if (!parts) return null
  for (const p of parts) {
    const [, num, unit] = p.match(/(\d+)([hms])/) || []
    if (!num) continue
    const n = Number(num)
    if (unit === 'h') total += n * 3600
    if (unit === 'm') total += n * 60
    if (unit === 's') total += n
  }
  return total || null
}

const formatTimestamp = seconds => {
  if (seconds === null || Number.isNaN(seconds)) return ''
  const s = Math.floor(seconds % 60).toString().padStart(2, '0')
  const m = Math.floor((seconds / 60) % 60).toString().padStart(2, '0')
  const h = Math.floor(seconds / 3600).toString().padStart(2, '0')
  return `${h}:${m}:${s}`
}

const parseTimestamp = value => {
  if (!value || typeof value !== 'string') return null
  const v = value.trim()
  if (!v) return null
  if (/^\d+$/.test(v)) return Number(v)
  const parts = v.split(':').map(Number)
  if (parts.some(n => Number.isNaN(n))) return null
  if (parts.length === 2) return parts[0] * 60 + parts[1]
  if (parts.length === 3) return parts[0] * 3600 + parts[1] * 60 + parts[2]
  return null
}

const useSegments = () => {
  const [segments, setSegments] = useState([emptySegment()])

  const update = (id, patch) =>
    setSegments(list => list.map(item => (item.id === id ? { ...item, ...patch } : item)))

  const add = () => setSegments(list => [...list, emptySegment()])

  const remove = id => setSegments(list => (list.length === 1 ? list : list.filter(item => item.id !== id)))

  return { segments, update, add, remove }
}

const SegmentRow = ({ seg, onChange, onRemove }) => {
  return (
    <div class="segment-row">
      <label class="label">
        URL
        <input
          value={seg.url}
          placeholder="https://www.youtube.com/watch?v=..."
          onInput={e => onChange('url', e.target.value)}
        />
        {seg.error && <span class="error">{seg.error}</span>}
      </label>
      <label class="label">
        Start
        <input value={seg.start} placeholder="HH:MM:SS" onInput={e => onChange('start', e.target.value)} />
      </label>
      <label class="label">
        End
        <input value={seg.end} placeholder="HH:MM:SS" onInput={e => onChange('end', e.target.value)} />
      </label>
      <button class="icon-btn danger" onClick={onRemove} aria-label="Remove segment">
        −
      </button>
    </div>
  )
}

const decodeStream = async (response, onLine) => {
  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  while (true) {
    const { value, done } = await reader.read()
    if (done) break
    buffer += decoder.decode(value, { stream: true })
    let idx
    while ((idx = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, idx).trim()
      buffer = buffer.slice(idx + 1)
      if (line) onLine(JSON.parse(line))
    }
  }
  if (buffer.trim()) onLine(JSON.parse(buffer.trim()))
}

const App = () => {
  const { segments, update, add, remove } = useSegments()
  const [debug, setDebug] = useState(false)
  const [status, setStatus] = useState('Waiting to start')
  const [badge, setBadge] = useState('Idle')
  const [logs, setLogs] = useState([])
  const [downloadUrl, setDownloadUrl] = useState('')
  const [running, setRunning] = useState(false)

  const parsedSegments = useMemo(() =>
    segments.map(seg => ({
      ...seg,
      startSeconds: parseTimestamp(seg.start),
      endSeconds: parseTimestamp(seg.end)
    })),
  [segments])

  const validate = () => {
    let ok = true
    parsedSegments.forEach(item => {
      let error = ''
      if (!item.url.trim()) error = 'URL required'
      else if (item.startSeconds === null || item.endSeconds === null) error = 'Timestamps required'
      else if (item.startSeconds >= item.endSeconds) error = 'Start must be before end'
      update(item.id, { error })
      if (error) ok = false
    })
    return ok
  }

  const handleUrl = (id, value) => {
    const matchTime = parseTimeParam(value)
    const current = segments.find(s => s.id === id)
    if (matchTime !== null && (current?.start || '').trim() === '') update(id, { start: formatTimestamp(matchTime) })
    update(id, { url: value })
  }

  const handleRun = async () => {
    setDownloadUrl('')
    setLogs([])
    setStatus('Validating inputs')
    setBadge('Validating')
    if (!validate()) return
    setRunning(true)
    try {
      const payload = {
        segments: parsedSegments.map(({ url, start, end }) => ({ url, start, end }))
      }
      const response = await fetch('/api/process', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      })
      if (!response.ok || !response.body) throw new Error('Request failed to start')
      await decodeStream(response, line => {
        if (line.type === 'status') {
          setStatus(line.message)
          setBadge(line.stage)
        }
        if (line.type === 'log' && debug) {
          setLogs(prev => [...prev.slice(-400), line.message.trim()])
        }
        if (line.type === 'error') {
          setStatus(line.message)
          setBadge('Error')
        }
        if (line.type === 'done') {
          setStatus('Done')
          setBadge('Complete')
          setDownloadUrl(line.downloadUrl)
        }
      })
    } catch (err) {
      setStatus(err.message || 'Failed')
      setBadge('Error')
    }
    setRunning(false)
  }

  const primaryLabel = running ? 'Working...' : 'Download & Stitch'

  return (
    <div class="app-shell">
      <div class="header">
        <div>
          <h1>Lightning Stitch for YouTube</h1>
          <div class="subtitle">Add clips, set timestamps, and get a fused video fast.</div>
        </div>
        <label class="toggle">
          Debug mode
          <div class="switch" data-on={debug} onClick={() => setDebug(v => !v)}>
            <div class="knob" />
          </div>
        </label>
      </div>

      <div class="segment-list">
        {segments.map(seg => (
          <SegmentRow
            key={seg.id}
            seg={seg}
            onChange={(field, value) => (field === 'url' ? handleUrl(seg.id, value) : update(seg.id, { [field]: value }))}
            onRemove={() => remove(seg.id)}
          />
        ))}
      </div>

      <div class="controls">
        <button class="icon-btn" onClick={add} aria-label="Add segment">
          +
        </button>
        <button class="primary" onClick={handleRun} disabled={running}>
          {primaryLabel}
        </button>
        {downloadUrl && (
          <a class="secondary" href={downloadUrl} download>
            Download result
          </a>
        )}
      </div>

      <div class="status-card">
        <div class="status-title">Status</div>
        <div class="status-message">
          <div>{status}</div>
          <div class="badge">{badge}</div>
        </div>
        {debug && logs.length > 0 && (
          <div class="log-panel">
            {logs.map((line, idx) => (
              <div key={`${line}-${idx}`} class="log-entry">
                {line}
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}

const root = createRoot(document.getElementById('app'))
root.render(<App />)
