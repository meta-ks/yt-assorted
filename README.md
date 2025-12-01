# Lightning Stitch for YouTube

Fast multi-segment YouTube downloader and stitcher. Add URLs with timestamps, fetch only the requested windows, and get a single merged video.

## Prerequisites
- Node.js 18+
- `ffmpeg` installed and in PATH
- `yt-dlp` installed and in PATH

## Setup
```bash
npm install
```

## Development
Runs API on port 3001 with the Vite UI on port 5173.
```bash
npm run dev
```

## Production build
Builds the UI into `server/public` and serves it with the Express backend on port 3001.
```bash
npm run build
npm start
```

## Usage
1. Add one or more YouTube URLs with start/end timestamps (HH:MM:SS, MM:SS, or seconds).
2. Click **Download & Stitch** to stream progress.
3. When finished, download the merged video via the provided link.

Debug mode shows verbose logs from the downloader and ffmpeg pipeline.
