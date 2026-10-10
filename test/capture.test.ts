import assert from 'node:assert/strict'
import { chmodSync, mkdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { test } from 'node:test'
import { launchArguments, liveWorkerCommand } from '../src/capture/capture.ts'
import { selfCommand } from '../src/core/self.ts'
import { bitaSubscription, capabilities, manifest } from '../src/setup/integration.ts'
import { successEnvelope } from '@kikedealba/kit/envelope'
import { platformContext, type PlatformContext } from '@kikedealba/kit/platform'
import { validateManifest } from '@kikedealba/kit/registry'
import { VERSION } from '../src/version.ts'
import { sandboxEnv, tempDir } from './helpers.ts'

const posix = process.platform !== 'win32'

function shimContext(t: { after: (fn: () => void) => void }, version: string | null): { ctx: PlatformContext; shim: string; bin: string } {
  const dir = tempDir(t)
  const bin = path.join(dir, 'bin')
  mkdirSync(bin)
  const shim = path.join(bin, 'recap')
  const answer = version === null ? 'not an envelope' : JSON.stringify(successEnvelope(1, 'capabilities', { name: 'recap', version, envelope: 1, capabilities: [], emits: [] }))
  writeFileSync(shim, `#!/bin/sh\nprintf '%s\\n' '${answer}'\n`)
  chmodSync(shim, 0o755)
  const env = sandboxEnv(dir, { PATH: `${bin}${path.delimiter}/usr/bin${path.delimiter}/bin` })
  return { ctx: platformContext({ env, home: dir }), shim, bin }
}

test('launches the capture subcommand of Recap.app with the TypeScript live worker', async (t) => {
  const { ctx } = shimContext(t, '0.0.0-other')
  const args = await launchArguments('/Applications/Recap.app', '/m', '/m/recorder.log', true, ctx)
  assert.deepEqual(args.slice(0, 4), ['-g', '-n', '-a', '/Applications/Recap.app'])
  assert.equal(args[args.indexOf('--env') + 1], `RECAP_LIVE_WORKER=${JSON.stringify(await liveWorkerCommand(ctx))}`)
  assert.equal(args.filter((arg) => arg === '--env').length, 1)
  assert.deepEqual(args.slice(-4), ['--args', 'capture', 'record', '/m'])
  assert.deepEqual(await liveWorkerCommand(ctx), [...selfCommand(), 'live-worker'])
  assert.deepEqual((await launchArguments('/Applications/Recap.app', '/m', '/m/recorder.log', false, ctx)).slice(-3), ['--args', 'record', '/m'])
})

test('the manifest subscribes to bita meeting events only when it can record', async (t) => {
  const { ctx } = shimContext(t, '0.0.0-other')
  assert.deepEqual(validateManifest(await manifest(true, true, ctx)), [])
  assert.deepEqual((await manifest(false, false, ctx)).subscribes, [])
  assert.ok(!capabilities(false).includes('meeting.record'))
  assert.ok(capabilities(true).includes('meeting.record'))
  const subscription = await bitaSubscription(ctx)
  assert.equal(subscription.tool, 'bita')
  assert.deepEqual(subscription.events, ['start', 'stop', 'cancel', 'amend'])
  assert.deepEqual(subscription.filter, { kind: ['in-person-meeting', 'remote-meeting'] })
  assert.equal(subscription.command.at(-1), 'bita-hook')
})

test('registers the recap on PATH when it answers with the same version', { skip: !posix && 'needs a POSIX shell' }, async (t) => {
  const { ctx, shim, bin } = shimContext(t, VERSION)
  const registered = await manifest(true, true, ctx)
  assert.deepEqual(registered.bin, [shim])
  assert.deepEqual(registered.subscribes[0]?.command, [shim, 'bita-hook'])
  assert.deepEqual(await liveWorkerCommand(ctx), [shim, 'live-worker'])
  const args = await launchArguments('/Applications/Recap.app', '/m', '/m/recorder.log', true, ctx)
  const envs = args.filter((_, index) => args[index - 1] === '--env')
  assert.equal(envs[0], `RECAP_LIVE_WORKER=${JSON.stringify([shim, 'live-worker'])}`)
  const searchPath = envs[1]?.replace(/^PATH=/, '').split(path.delimiter) ?? []
  assert.equal(searchPath[0], path.dirname(process.execPath))
  assert.ok(searchPath.includes(bin))
})

test('falls back to the package path when the recap on PATH is another version or not the CLI', { skip: !posix && 'needs a POSIX shell' }, async (t) => {
  for (const version of ['0.3.0', null]) {
    const { ctx } = shimContext(t, version)
    const registered = await manifest(true, true, ctx)
    assert.deepEqual(registered.bin, selfCommand())
    assert.deepEqual(registered.subscribes[0]?.command, [...selfCommand(), 'bita-hook'])
    assert.deepEqual(await liveWorkerCommand(ctx), [...selfCommand(), 'live-worker'])
  }
})
