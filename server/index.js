import express from 'express'
import cors from 'cors'
import path from 'path'
import fs from 'fs'
import os from 'os'
import { spawn } from 'child_process'
import crypto from 'crypto'

const app = express()
const port = process.env.PORT || 3001
const jobs = new Map()
const publicDir = path.join(process.cwd(), 'server', 'public')

const ensureDir = dir => {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true })
}
ensureDir(publicDir)

app.use(cors())
app.use(express.json({ limit: '1mb' }))

const cleanupOldJobs = () => {
  const cutoff = Date.now() - 60 * 60 * 1000
  for (const [id, info] of jobs.entries()) {
    if (info.created < cutoff) {
      try {
        fs.rmSync(info.path, { force: true })
        if (info.tempDir) fs.rmSync(info.tempDir, { recursive: true, force: true })
      } catch {}
      jobs.delete(id)
    }
  }
}
setInterval(cleanupOldJobs, 15 * 60 * 1000)

const writeLine = (res, payload) => {
  res.write(`${JSON.stringify(payload)}\n`)
}

const parseTimestamp = value => {
  if (typeof value !== 'string' || !value.trim()) return null
  const v = value.trim()
  if (/^\d+$/.test(v)) return Number(v)
  const parts = v.split(':').map(Number)
  if (parts.some(n => Number.isNaN(n))) return null
  if (parts.length === 2) return parts[0] * 60 + parts[1]
  if (parts.length === 3) return parts[0] * 3600 + parts[1] * 60 + parts[2]
  return null
}

const formatTimestamp = seconds => {
  const s = Math.floor(seconds % 60).toString().padStart(2, '0')
  const m = Math.floor((seconds / 60) % 60).toString().padStart(2, '0')
  const h = Math.floor(seconds / 3600).toString().padStart(2, '0')
  return `${h}:${m}:${s}`
}

const runCommand = (cmd, args, log) =>
  new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'] })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', chunk => {
      stdout += chunk.toString()
      log(chunk.toString(), false)
    })
    child.stderr.on('data', chunk => {
      stderr += chunk.toString()
      log(chunk.toString(), true)
    })
    child.on('error', err => reject(err))
    child.on('close', code => {
      if (code === 0) resolve(stdout.trim())
      else reject(new Error(stderr || `Command failed: ${cmd}`))
    })
  })

app.post('/api/process', async (req, res) => {
  res.setHeader('Content-Type', 'application/x-ndjson')
  res.setHeader('Cache-Control', 'no-cache')
  res.setHeader('Connection', 'keep-alive')
  res.flushHeaders?.()

  const segments = Array.isArray(req.body?.segments) ? req.body.segments : []
  if (!segments.length) {
    writeLine(res, { type: 'error', message: 'No segments provided' })
    return res.end()
  }

  const parsed = []
  for (const [index, seg] of segments.entries()) {
    const url = typeof seg.url === 'string' ? seg.url.trim() : ''
    const start = parseTimestamp(seg.start)
    const end = parseTimestamp(seg.end)
    if (!url) {
      writeLine(res, { type: 'error', message: `Row ${index + 1}: URL required` })
      return res.end()
    }
    if (start === null || end === null || start >= end) {
      writeLine(res, { type: 'error', message: `Row ${index + 1}: Invalid timestamps` })
      return res.end()
    }
    parsed.push({ url, start, end })
  }

  const jobId = crypto.randomUUID()
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'yt-stitch-'))
  const segmentPaths = []

  const log = (message, stderr = false) => {
    writeLine(res, { type: 'log', channel: stderr ? 'stderr' : 'stdout', message })
  }

  writeLine(res, { type: 'status', stage: 'starting', message: 'Validating inputs' })

  try {
    for (const [idx, seg] of parsed.entries()) {
      const label = `${idx + 1}/${parsed.length}`
      writeLine(res, { type: 'status', stage: 'resolving', message: `Resolving segment ${label}` })
      const directUrl = await runCommand('yt-dlp', ['-f', 'best', '-g', seg.url], log)
      writeLine(res, { type: 'status', stage: 'downloading', message: `Downloading segment ${label}` })
      const segmentPath = path.join(tempDir, `segment-${idx}.mp4`)
      const duration = (seg.end - seg.start).toString()
      await runCommand('ffmpeg', ['-ss', seg.start.toString(), '-i', directUrl, '-t', duration, '-c', 'copy', '-avoid_negative_ts', 'make_zero', '-y', segmentPath], log)
      segmentPaths.push(segmentPath)
      writeLine(res, { type: 'status', stage: 'downloaded', message: `Segment ${label} ready (${formatTimestamp(seg.start)}-${formatTimestamp(seg.end)})` })
    }

    writeLine(res, { type: 'status', stage: 'stitching', message: 'Stitching segments' })
    const listPath = path.join(tempDir, 'concat-list.txt')
    const listContent = segmentPaths.map(p => `file '${p.replace(/'/g, "'\\''")}'`).join('\n')
    fs.writeFileSync(listPath, listContent)
    const outputPath = path.join(tempDir, 'stitched.mp4')
    await runCommand('ffmpeg', ['-f', 'concat', '-safe', '0', '-i', listPath, '-c', 'copy', '-y', outputPath], log)

    const finalName = `stitch-${Date.now()}.mp4`
    const finalPath = path.join(publicDir, finalName)
    fs.copyFileSync(outputPath, finalPath)

    jobs.set(jobId, { path: finalPath, created: Date.now(), tempDir })
    writeLine(res, { type: 'done', downloadId: jobId, downloadUrl: `/api/download/${jobId}` })
  } catch (err) {
    writeLine(res, { type: 'error', message: err.message || 'Processing failed' })
    try {
      fs.rmSync(tempDir, { recursive: true, force: true })
    } catch {}
  }

  res.end()
})

app.get('/api/download/:id', (req, res) => {
  const info = jobs.get(req.params.id)
  if (!info) return res.status(404).json({ error: 'Not found' })
  res.download(info.path, err => {
    if (err) return res.status(500).end()
  })
})

app.use(express.static(publicDir))

app.listen(port, () => {
  console.log(`Server running on http://localhost:${port}`)
})
