import assert from 'node:assert/strict'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { test } from 'node:test'
import { defineManifest, registerTool, unregisterTool } from '@kikedealba/kit/registry'
import { runWrapup } from '../src/bita/wrapup.ts'
import { loadMeeting, recordingPath, saveMeeting, type Meeting } from '../src/core/meeting.ts'
import { Pipeline } from '../src/pipeline/pipeline.ts'
import { meeting, tempDir } from './helpers.ts'

const FAKE_TOOL = `
const fs = require('node:fs')
const [log, name] = process.argv.slice(2, 4)
const args = process.argv.slice(4).filter((arg) => arg !== '--json')
fs.appendFileSync(log, JSON.stringify([name, ...args]) + '\\n')
const ok = (data) => process.stdout.write(JSON.stringify({ schemaVersion: 1, ok: true, command: args.slice(0, 2).join(' '), generatedAt: new Date().toISOString(), data }))
const key = args.slice(0, 2).join(' ')
if (name === 'bita') {
  if (key === 'projects') ok([{ name: 'CoDi', active: true }, { name: 'Old', active: false }])
  else ok({})
} else {
  if (key === 'page ls') ok({ pages: [] })
  else if (key === 'page new') ok({ page: { pageId: 12, title: args[2] } })
  else if (key === 'backlog add') ok({ key: 'COD-' + (fs.readFileSync(log, 'utf8').split('backlog').length - 1) })
  else ok({})
}
`

interface Fakes {
  log: string
  calls: () => string[][]
  register: (name: string, capabilities: string[]) => Promise<void>
}

async function fakes(t: Parameters<typeof tempDir>[0]): Promise<Fakes> {
  const root = tempDir(t, 'recap-fakes-')
  const script = path.join(root, 'fake-tool.cjs')
  const log = path.join(root, 'calls.log')
  writeFileSync(script, FAKE_TOOL)
  writeFileSync(log, '')
  const registered: string[] = []
  t.after(async () => {
    for (const name of registered) await unregisterTool(name)
  })
  return {
    log,
    calls: () =>
      readFileSync(log, 'utf8')
        .split('\n')
        .filter((line) => line.length > 0)
        .map((line) => JSON.parse(line) as string[]),
    register: async (name, capabilities) => {
      await registerTool(defineManifest({ name, version: '9.0.0', bin: [process.execPath, script, log, name], capabilities }))
      registered.push(name)
    },
  }
}

const ALL_DOCS = ['docs.page.read', 'docs.page.write', 'docs.backlog', 'docs.history', 'docs.propose', 'docs.entry-notes']

const PLAN = JSON.stringify({
  title: 'Daily de CoDi',
  project: 'CoDi',
  pageTitle: 'Daily de CoDi',
  pageMarkdown: '## Acuerdos\nSe despliega el viernes.',
  backlog: [
    { kind: 'pending', title: 'Configurar el webhook', body: 'En QA.' },
    { kind: 'finding', title: 'El sandbox no firma' },
  ],
})

function prepared(t: Parameters<typeof tempDir>[0], overrides: Partial<Meeting> = {}): string {
  const dir = tempDir(t)
  const value = meeting({
    mode: 'in-person',
    status: 'recorded',
    startedAt: '2026-10-10T10:00:00Z',
    endedAt: '2026-10-10T10:30:00Z',
    bitaEntryId: 42,
    bitaEntry: { title: 'Reunión presencial', kind: 'in-person-meeting', pageIds: [] },
    stages: {
      audio: { status: 'done', updatedAt: '2026-10-10T10:31:00Z' },
      transcribe: { status: 'done', updatedAt: '2026-10-10T10:31:00Z' },
      summarize: { status: 'done', updatedAt: '2026-10-10T10:31:00Z' },
    },
    ...overrides,
  })
  saveMeeting(value, dir)
  mkdirSync(path.dirname(recordingPath(dir, value.mode)), { recursive: true })
  writeFileSync(recordingPath(dir, value.mode), 'audio')
  writeFileSync(path.join(dir, 'summary.md'), '# Daily\n\n## Resumen\nTodo bien.\n')
  writeFileSync(path.join(dir, 'transcript.md'), '**[00:00:01] Sala:** hola')
  return dir
}

test('the wrap-up writes the page, the backlog and the minutes to inkwell and only amends bita', async (t) => {
  const fake = await fakes(t)
  await fake.register('bita', ['time.entries.read', 'time.entries.write', 'time.events'])
  await fake.register('inkwell', ALL_DOCS)
  const dir = prepared(t)
  const lines: string[] = []
  await runWrapup(loadMeeting(dir), dir, {}, { claude: async () => PLAN, log: (line) => lines.push(line) })
  const calls = fake.calls()
  const inkwell = calls.filter((call) => call[0] === 'inkwell').map((call) => call.slice(1))
  const bita = calls.filter((call) => call[0] === 'bita').map((call) => call.slice(1))
  assert.deepEqual(inkwell[0], ['page', 'ls', '--entry', '42'])
  assert.deepEqual(inkwell[1], ['page', 'new', 'Daily de CoDi', '--from-entry', '42', '--project', 'CoDi'])
  assert.deepEqual(inkwell[2], ['page', 'write', '12', '--md', path.join(dir, 'wrapup-page.md')])
  assert.deepEqual(
    inkwell.filter((call) => call[0] === 'backlog').map((call) => call.slice(0, 7)),
    [
      ['backlog', 'add', '--kind', 'pending', '--title', 'Configurar el webhook', '--page'],
      ['backlog', 'add', '--kind', 'finding', '--title', 'El sandbox no firma', '--page'],
    ],
  )
  assert.deepEqual(inkwell.at(-1), ['note', 'save', '42', '--section', 'Reunión', '--md', path.join(dir, 'entry-note.md')])
  assert.ok(bita.every((call) => ['projects', 'amend'].includes(call[0] ?? '')))
  assert.ok(bita.some((call) => call.join(' ') === 'amend 42 --title Daily de CoDi'))
  assert.ok(bita.some((call) => call.join(' ') === 'amend 42 --project CoDi'))
  const after = loadMeeting(dir)
  assert.equal(after.wrapup?.pageId, 12)
  assert.equal(after.wrapup?.pageCreated, true)
  assert.deepEqual(Object.keys(after.wrapup?.backlogKeys ?? {}), ['Configurar el webhook', 'El sandbox no firma'])
  assert.ok(lines.some((line) => line.includes('saved in the note of entry #42')))
})

test('an existing page linked in inkwell gets a new section instead of a new page', async (t) => {
  const fake = await fakes(t)
  await fake.register('bita', ['time.entries.read'])
  await fake.register('inkwell', ALL_DOCS)
  const dir = prepared(t, { wrapup: { pageId: 30, titleChanged: false, projectResolved: true, pageCreated: false, backlogKeys: { 'Configurar el webhook': 'COD-1' } } })
  await runWrapup(loadMeeting(dir), dir, {}, { claude: async () => PLAN })
  const inkwell = fake.calls().filter((call) => call[0] === 'inkwell').map((call) => call.slice(1))
  assert.ok(!inkwell.some((call) => call.join(' ').startsWith('page new')))
  assert.ok(inkwell.some((call) => call.join(' ') === 'page show 30'))
  assert.ok(inkwell.some((call) => call.slice(0, 3).join(' ') === 'page write 30' && call.includes('--section')))
  assert.equal(inkwell.filter((call) => call[0] === 'backlog').length, 1)
})

test('without docs.entry-notes the minutes stay in the meeting folder', async (t) => {
  const fake = await fakes(t)
  await fake.register('bita', ['time.entries.read'])
  await fake.register('inkwell', ['docs.page.read', 'docs.page.write', 'docs.backlog'])
  const dir = prepared(t)
  const lines: string[] = []
  await runWrapup(loadMeeting(dir), dir, {}, { claude: async () => PLAN, log: (line) => lines.push(line) })
  assert.ok(!fake.calls().some((call) => call[1] === 'note'))
  assert.ok(lines.some((line) => line.includes('not saved') && line.includes('docs.entry-notes')))
  assert.equal(loadMeeting(dir).wrapup?.pageId, 12)
})

test('without inkwell the proposals and wrap-up stages are skipped and the meeting is processed', async (t) => {
  const fake = await fakes(t)
  await fake.register('bita', ['time.entries.read'])
  const dir = prepared(t)
  const lines: string[] = []
  const pipeline = new Pipeline(dir, {}, (line) => lines.push(line))
  await pipeline.run(undefined, 'proposals')
  const after = await pipeline.run(undefined, 'wrapup')
  assert.equal(after.status, 'processed')
  assert.equal(after.stages['proposals']?.status, 'skipped')
  assert.equal(after.stages['wrapup']?.status, 'skipped')
  assert.equal(after.stages['wrapup']?.reason, 'inkwell is not installed')
  assert.ok(after.stages['wrapup']?.hint?.includes('npm i -g @kikedealba/inkwell'))
  assert.ok(lines.some((line) => line.startsWith('wrapup: skipped, inkwell is not installed')))
  assert.deepEqual(fake.calls(), [])
})

test('an inkwell with entry notes but without the wrap-up capabilities still gets the minutes', async (t) => {
  const fake = await fakes(t)
  await fake.register('bita', ['time.entries.read'])
  await fake.register('inkwell', ['docs.page.read', 'docs.entry-notes'])
  const dir = prepared(t)
  const lines: string[] = []
  await new Pipeline(dir, {}, (line) => lines.push(line)).run(undefined, 'wrapup')
  const after = loadMeeting(dir)
  assert.equal(after.stages['wrapup']?.status, 'skipped')
  assert.ok(after.stages['wrapup']?.reason?.includes('docs.page.write'))
  assert.deepEqual(
    fake.calls().map((call) => call.slice(0, 5)),
    [['inkwell', 'note', 'save', '42', '--section']],
  )
})
