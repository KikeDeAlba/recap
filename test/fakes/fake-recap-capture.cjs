const fs = require('node:fs')
const path = require('node:path')

const [, , command, dir] = process.argv
const behavior = process.env.FAKE_CAPTURE_CAPS || 'announce'

function stamp() {
  return new Date().toISOString().replace(/\.\d{3}Z$/, 'Z')
}

function update(file, change) {
  const meeting = JSON.parse(fs.readFileSync(file, 'utf8'))
  change(meeting)
  fs.writeFileSync(file, JSON.stringify(meeting))
}

if (command === 'capabilities' && behavior === 'hang') {
  fs.writeFileSync(path.join(path.dirname(process.argv[1]), 'capabilities.pid'), String(process.pid))
  setInterval(() => undefined, 1000)
} else if (command === 'capabilities') {
  if (behavior === 'fail') {
    process.stderr.write('unknown command\n')
    process.exit(64)
  }
  if (behavior === 'garbage') {
    process.stdout.write('not json at all\n')
    process.exit(0)
  }
  const capabilities = behavior === 'legacy' ? ['capture.remote', 'capture.in-person'] : ['capture.remote', 'capture.in-person', 'capture.meeting', ...(behavior === 'switch' ? ['capture.sources', 'capture.switch'] : [])]
  process.stdout.write(`${JSON.stringify({ schemaVersion: 1, ok: true, command: 'capabilities', generatedAt: stamp(), data: { name: 'recap-capture', capabilities } })}\n`)
  process.exit(0)
} else if (command === 'sources') {
  if (behavior !== 'switch') {
    process.stdout.write(`${JSON.stringify({ schemaVersion: 1, ok: false, command: 'sources', generatedAt: stamp(), error: { code: 'USAGE', message: 'Unexpected argument sources' } })}\n`)
    process.exit(64)
  }
  process.stdout.write(`${JSON.stringify({ schemaVersion: 1, ok: true, command: 'sources', generatedAt: stamp(), data: sources(process.argv.includes('--thumbnails')) })}\n`)
  process.exit(0)
} else if (command === 'record' && behavior === 'switch' && JSON.parse(fs.readFileSync(path.join(dir, 'meeting.json'), 'utf8')).mode === 'meeting') {
  recordMeeting(dir)
} else if (command === 'record') {
  const file = path.join(dir, 'meeting.json')
  let mode = 'unknown'
  update(file, (meeting) => {
    mode = meeting.mode
    meeting.status = 'recording'
    meeting.startedAt = stamp()
    meeting.recorderPid = process.pid
  })
  fs.writeFileSync(path.join(dir, mode === 'remote' ? 'recording.mov' : 'recording.m4a'), Buffer.alloc(64, 7))
  fs.writeFileSync(path.join(dir, 'fake-recorder-mode.txt'), mode)
  const finish = () => {
    update(file, (meeting) => {
      meeting.status = 'recorded'
      meeting.endedAt = stamp()
      delete meeting.recorderPid
    })
    process.exit(0)
  }
  process.on('SIGINT', finish)
  process.on('SIGTERM', finish)
  setInterval(() => undefined, 1000)
} else {
  process.stderr.write(`unsupported command ${command}\n`)
  process.exit(64)
}

function sources(thumbnails) {
  const thumbnail = thumbnails ? { thumbnail: 'data:image/jpeg;base64,/9j/4AAQ' } : {}
  return {
    displays: [{ id: 1, name: 'Built-in Retina Display', width: 1512, height: 982, main: true, ...thumbnail }],
    windows: [{ id: 4242, app: 'zoom.us', bundleId: 'us.zoom.xos', title: 'Zoom Meeting', pid: 777, width: 1280, height: 800, ...thumbnail }],
  }
}

function recordMeeting(dir) {
  const file = path.join(dir, 'meeting.json')
  const control = path.join(dir, 'control')
  const manifestFile = path.join(dir, 'capture.json')
  const manifest = { version: 1, mic: 'mic.m4a', startedAt: stamp(), video: null, segments: [] }
  const writeManifest = () => fs.writeFileSync(manifestFile, JSON.stringify(manifest))
  fs.writeFileSync(path.join(dir, 'mic.m4a'), Buffer.alloc(64, 7))
  fs.mkdirSync(control, { recursive: true })
  writeManifest()
  update(file, (meeting) => {
    meeting.status = 'recording'
    meeting.startedAt = stamp()
    meeting.recorderPid = process.pid
  })
  const started = Date.now()
  const status = () => ({ mic: true, systemAudio: manifest.video !== null, video: manifest.video })
  const closeSegment = () => {
    const open = manifest.segments[manifest.segments.length - 1]
    if (open && open.endMs === undefined) open.endMs = Date.now() - started
    manifest.video = null
  }
  const answer = (request) => {
    if (request.action === 'sources') return { ok: true, data: sources(Boolean(request.thumbnails)) }
    if (request.action === 'clear') {
      closeSegment()
      return { ok: true, data: status() }
    }
    if (request.action === 'set') {
      const { kind, id } = request.target
      if (kind === 'window' && id !== 4242) return { ok: false, error: { code: 'WINDOW_GONE', message: `Window ${id} is closed or no longer on screen` } }
      if (process.env.FAKE_CAPTURE_SCREEN === 'denied') return { ok: false, error: { code: 'SCREEN_PERMISSION_DENIED', message: 'Recap has no screen recording access.' } }
      const video = kind === 'window' ? { kind, id, title: 'Zoom Meeting', app: 'zoom.us', since: stamp() } : { kind, id, title: 'Built-in Retina Display', app: null, since: stamp() }
      if (manifest.video === null) manifest.segments.push({ file: `screen-${manifest.segments.length + 1}.mov`, startMs: Date.now() - started, targets: [] })
      manifest.video = video
      return { ok: true, data: status() }
    }
    return { ok: false, error: { code: 'CONTROL_INVALID', message: 'bad request' } }
  }
  if (process.env.FAKE_CAPTURE_CONTROL === 'silent') {
    fs.writeFileSync(path.join(dir, 'fake-recorder-mode.txt'), 'meeting')
  } else {
    setInterval(() => {
      for (const name of fs.readdirSync(control).filter((item) => item.endsWith('.request.json') && !item.startsWith('.')).sort()) {
        const id = name.slice(0, -'.request.json'.length)
        const request = JSON.parse(fs.readFileSync(path.join(control, name), 'utf8'))
        fs.rmSync(path.join(control, name))
        const reply = { id, ...answer(request) }
        writeManifest()
        fs.writeFileSync(path.join(control, `.${id}.tmp`), JSON.stringify(reply))
        fs.renameSync(path.join(control, `.${id}.tmp`), path.join(control, `${id}.response.json`))
      }
    }, 20)
  }
  const finish = () => {
    closeSegment()
    manifest.endedAt = stamp()
    writeManifest()
    update(file, (meeting) => {
      meeting.status = 'recorded'
      meeting.endedAt = stamp()
      delete meeting.recorderPid
    })
    process.exit(0)
  }
  process.on('SIGINT', finish)
  process.on('SIGTERM', finish)
  setInterval(() => undefined, 1000)
}
