const fs = require('node:fs')

const args = process.argv.slice(2)
if (process.env.FAKE_LOG) fs.appendFileSync(process.env.FAKE_LOG, `${JSON.stringify(args)}\n`)

function source() {
  if (process.env.FAKE_FAIL && args.join(' ').includes(process.env.FAKE_FAIL)) {
    process.stderr.write('device busy\n')
    process.exit(1)
  }
  if (process.env.FAKE_DIE && args.join(' ').includes(process.env.FAKE_DIE)) setTimeout(() => process.exit(3), 600)
  const helper = args.includes('--source')
  const channels = Number(args[args.indexOf(helper ? '--channels' : '-ac') + 1]) || 1
  if (helper) process.stderr.write(`${JSON.stringify({ event: 'started', channels, rate: 48000 })}\n`)
  const frames = 4800
  let position = 0
  const timer = setInterval(() => {
    const block = Buffer.alloc(frames * channels * 2)
    for (let frame = 0; frame < frames; frame += 1) {
      const value = Math.round(8000 * Math.sin((2 * Math.PI * 440 * (position + frame)) / 48000))
      for (let channel = 0; channel < channels; channel += 1) block.writeInt16LE(value, (frame * channels + channel) * 2)
    }
    position += frames
    process.stdout.write(block)
  }, 100)
  const stop = () => {
    clearInterval(timer)
    process.exit(0)
  }
  process.stdin.on('data', (data) => {
    if (data.includes('q')) stop()
  })
  process.stdin.on('end', stop)
}

if (args.includes('-devices')) {
  process.stdout.write(process.env.FAKE_NO_PULSE ? ' D  alsa   ALSA audio input\n' : ' D  pulse   Pulse audio input\n')
} else if (args.includes('pulse') || args.includes('dshow') || args.includes('--source')) {
  source()
} else if (args.includes('pipe:0')) {
  const output = fs.createWriteStream(args[args.length - 1])
  process.stdin.pipe(output)
  output.on('finish', () => process.exit(0))
} else if (args.includes('copy')) {
  fs.writeFileSync(args[args.length - 1], JSON.stringify(args))
}
