import assert from 'node:assert/strict'
import { test } from 'node:test'
import { launchArguments, liveWorkerCommand } from '../src/capture/capture.ts'
import { bitaSubscription, capabilities, manifest } from '../src/setup/integration.ts'
import { validateManifest } from '@kikedealba/kit/registry'
import './helpers.ts'

test('launches the capture subcommand of Recap.app with the TypeScript live worker', () => {
  const args = launchArguments('/Applications/Recap.app', '/m', '/m/recorder.log', true)
  assert.deepEqual(args.slice(0, 4), ['-g', '-n', '-a', '/Applications/Recap.app'])
  assert.equal(args[args.indexOf('--env') + 1], `RECAP_LIVE_WORKER=${liveWorkerCommand()}`)
  assert.deepEqual(args.slice(-4), ['--args', 'capture', 'record', '/m'])
  const command = JSON.parse(liveWorkerCommand()) as string[]
  assert.equal(command.at(-1), 'live-worker')
  assert.deepEqual(launchArguments('/Applications/Recap.app', '/m', '/m/recorder.log', false).slice(-3), ['--args', 'record', '/m'])
})

test('the manifest subscribes to bita meeting events only when it can record', () => {
  assert.deepEqual(validateManifest(manifest(true)), [])
  assert.deepEqual(manifest(false).subscribes, [])
  assert.ok(!capabilities(false).includes('meeting.record'))
  assert.ok(capabilities(true).includes('meeting.record'))
  const subscription = bitaSubscription()
  assert.equal(subscription.tool, 'bita')
  assert.deepEqual(subscription.events, ['start', 'stop', 'cancel', 'amend'])
  assert.deepEqual(subscription.filter, { kind: ['in-person-meeting', 'remote-meeting'] })
  assert.equal(subscription.command.at(-1), 'bita-hook')
})
