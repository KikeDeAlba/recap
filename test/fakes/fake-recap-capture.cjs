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
  const capabilities = behavior === 'legacy' ? ['capture.remote', 'capture.in-person'] : ['capture.remote', 'capture.in-person', 'capture.meeting']
  process.stdout.write(`${JSON.stringify({ schemaVersion: 1, ok: true, command: 'capabilities', generatedAt: stamp(), data: { name: 'recap-capture', capabilities } })}\n`)
  process.exit(0)
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
