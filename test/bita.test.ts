import assert from 'node:assert/strict'
import { test } from 'node:test'
import { decodeHookEvent, eventSnapshot, eventTarget, planHook } from '../src/bita/hook.ts'
import { chooseProject, demoteHeadings, isGenericTitle, noteBody, parseWrapup } from '../src/bita/wrapup.ts'
import { isSettled } from '../src/cli/commands/query.ts'
import { legacyHookIndexes } from '../src/setup/legacy.ts'
import { RecapError } from '../src/errors.ts'
import { meeting } from './helpers.ts'

function event(name: string, options: { kind?: string | null; previous?: string; running?: boolean } = {}) {
  const entry: Record<string, unknown> = { id: 7, description: 'Daily', running: options.running ?? true }
  if (options.kind) entry['kind'] = options.kind
  const payload: Record<string, unknown> = { event: name, entry, databasePath: '/data/bita.db', docsRoot: '/data/docs' }
  if (options.previous) payload['previousKind'] = options.previous
  return decodeHookEvent(JSON.stringify(payload))
}

test('the planner starts in the mode of the kind', () => {
  assert.deepEqual(planHook(event('start', { kind: 'remote-meeting' }), undefined), { type: 'start', mode: 'remote' })
  assert.deepEqual(planHook(event('start', { kind: 'in-person-meeting' }), undefined), { type: 'start', mode: 'in-person' })
})

test('the planner ignores starts that are not meetings or collide', () => {
  assert.deepEqual(planHook(event('start', { kind: 'pairing' }), undefined), { type: 'ignore', reason: 'entry #7 is not a meeting' })
  assert.deepEqual(planHook(event('start', { kind: 'remote-meeting' }), 3), { type: 'ignore', reason: 'another meeting is already being recorded' })
})

test('the planner stops only the recording of that entry and discards on cancel', () => {
  assert.deepEqual(planHook(event('stop', { kind: 'remote-meeting' }), 7), { type: 'stopAndProcess' })
  assert.deepEqual(planHook(event('stop', { kind: 'remote-meeting' }), 3), { type: 'processIfRecorded' })
  assert.deepEqual(planHook(event('cancel', { kind: 'in-person-meeting' }), 7), { type: 'discard' })
})

test('amend starts or stops when the kind crosses the meeting line', () => {
  assert.deepEqual(planHook(event('amend', { kind: 'remote-meeting' }), undefined), { type: 'start', mode: 'remote' })
  assert.deepEqual(planHook(event('amend', { kind: 'remote-meeting', running: false }), undefined), { type: 'ignore', reason: 'entry #7 already stopped' })
  assert.deepEqual(planHook(event('amend', { kind: null, previous: 'remote-meeting' }), 7), { type: 'stopWithoutProcessing' })
  assert.deepEqual(planHook(event('amend', { kind: 'in-person-meeting', previous: 'remote-meeting' }), 7), { type: 'ignore', reason: 'kind change does not affect the recording' })
})

test('the event carries the bita database, docs, project and pages', () => {
  assert.deepEqual(eventTarget(event('start', { kind: 'remote-meeting' })), { databasePath: '/data/bita.db', docsRoot: '/data/docs' })
  const parsed = decodeHookEvent('{"event":"stop","entry":{"id":9,"description":"Reunión presencial","kind":"in-person-meeting","running":false,"projectName":null},"pageIds":[151],"databasePath":"/d/bita.db","docsRoot":"/d/docs","source":"bita"}')
  assert.deepEqual(eventSnapshot(parsed), { title: 'Reunión presencial', projectName: undefined, kind: 'in-person-meeting', pageIds: [151] })
})

test('the note demotes headings so they stay inside one section', () => {
  const value = meeting({ startedAt: '1970-01-01T00:00:00Z', endedAt: '1970-01-01T00:30:00Z', status: 'processed' })
  const summary = '# Daily\n\n2 de octubre · 30m · reunión remota\n\n## Resumen\nTodo bien.\n\n```\n## not a heading\n```\n\n## Pendientes\n| # | Pendiente |'
  const body = noteBody(summary, value, '/tmp/m')
  assert.ok(body.startsWith('Minuta de la reunión remota (30m00s)'))
  assert.ok(body.includes('\n### Resumen\n'))
  assert.ok(body.includes('\n### Pendientes\n'))
  assert.ok(body.includes('\n## not a heading\n'))
  assert.ok(!body.includes('# Daily'))
  assert.ok(body.includes('`/tmp/m` (`summary.md`, `transcript.md`, `frames/`)'))
})

test('the wrap-up parser reads JSON wrapped in text and drops forbidden sections', () => {
  const answer = `Aquí está:
{"title":"  Reunión presencial: recompra con cupón  ","project":"Dportenis","pageTitle":"",
 "pageMarkdown":"## Contexto\\nCupón post-entrega.\\n\\n## Pendientes\\n- Algo\\n\\n## Arquitectura\\nLambda y DynamoDB.",
 "backlog":[{"kind":"pending","title":"Confirmar la cola","body":"Responsable: Ana"},
            {"kind":"todo","title":"Inválido","body":null},
            {"kind":"finding","title":"  ","body":null}]}
Listo.`
  const plan = parseWrapup(answer)
  assert.equal(plan.title, 'Reunión presencial: recompra con cupón')
  assert.equal(plan.pageTitle, plan.title)
  assert.equal(plan.project, 'Dportenis')
  assert.ok(!plan.pageMarkdown.includes('Pendientes'))
  assert.ok(plan.pageMarkdown.includes('## Arquitectura'))
  assert.deepEqual(plan.backlog, [{ kind: 'pending', title: 'Confirmar la cola', body: 'Responsable: Ana' }])
})

test('the wrap-up parser rejects answers without JSON or with empty fields', () => {
  assert.throws(() => parseWrapup('no json here'), RecapError)
  assert.throws(() => parseWrapup('{"title":"","project":null,"pageTitle":"x","pageMarkdown":"## A\\nb","backlog":[]}'), RecapError)
  assert.throws(() => parseWrapup('{"title":"x"}'), RecapError)
})

test('headings are demoted outside code fences', () => {
  assert.equal(demoteHeadings('## Flujo\n```mermaid\n## not a heading\n```\n### Paso'), '### Flujo\n```mermaid\n## not a heading\n```\n#### Paso')
})

test('generic titles and project choice', () => {
  for (const title of ['', 'Reunión presencial', 'reunion', 'Junta', 'Meet', 'In-person meeting', 'Remote meeting', 'Reunión remota']) assert.ok(isGenericTitle(title), title)
  for (const title of ['Reunión presencial: recompra con cupón', 'Daily SSO', 'Planeación sprint 42']) assert.ok(!isGenericTitle(title), title)
  const available = ['Dportenis', 'SSO', 'Pharma STI']
  assert.deepEqual(chooseProject('SSO', 'Dportenis', available), { apply: null, resolved: true })
  assert.deepEqual(chooseProject(null, 'dportenis', available), { apply: 'Dportenis', resolved: true })
  assert.deepEqual(chooseProject(null, 'Viva Aerobus', available), { apply: null, resolved: false })
  assert.deepEqual(chooseProject(null, null, available), { apply: null, resolved: false })
})

test('wait settles on processed or on a failed stage', () => {
  const failed = { wrapup: { status: 'failed', updatedAt: '2026-01-01T00:00:00Z', error: 'boom' } }
  assert.ok(isSettled(meeting({ status: 'processed' })))
  assert.ok(isSettled(meeting({ status: 'recorded', stages: failed })))
  assert.ok(!isSettled(meeting({ status: 'recorded' })))
  assert.ok(!isSettled(meeting({ status: 'recording' })))
  assert.ok(!isSettled(meeting({ status: 'processing' })))
})

test('old bita hooks pointing at recap are found by their 1-based index', () => {
  const data = [
    { on: ['stop'], command: ['/usr/bin/say', 'done'] },
    { on: ['start', 'stop'], command: ['/Users/me/.local/bin/recap', 'bita-hook'] },
    { on: ['start'], command: ['/Applications/Recap.app/Contents/MacOS/recap', 'bita-hook'] },
  ]
  assert.deepEqual(legacyHookIndexes(data), [2, 3])
  assert.deepEqual(legacyHookIndexes(null), [])
})

test('amend only starts or stops when the kind really changes', () => {
  const amend = (payload: Record<string, unknown>) =>
    decodeHookEvent(JSON.stringify({ event: 'amend', entry: { id: 7, description: 'Daily de CoDi', kind: 'remote-meeting', running: true }, ...payload }))
  const titleOnly = amend({ previousKind: 'remote-meeting', previousTitle: 'Reunión remota', previousProjectId: null })
  assert.equal(titleOnly.kindChanged, false)
  assert.deepEqual(planHook(titleOnly, undefined), { type: 'refresh' })
  assert.deepEqual(planHook(titleOnly, 7), { type: 'refresh' })
  assert.deepEqual(planHook(amend({ previousTitle: 'x', previousProjectId: 3 }), 7), { type: 'refresh' })
  assert.deepEqual(planHook(amend({ previousKind: null, previousTitle: 'x' }), undefined), { type: 'start', mode: 'remote' })
  assert.deepEqual(planHook(amend({}), undefined), { type: 'start', mode: 'remote' })
  const stopped = decodeHookEvent(JSON.stringify({ event: 'amend', entry: { id: 7, description: 'Daily', running: true }, previousKind: 'remote-meeting', previousTitle: 'Daily' }))
  assert.deepEqual(planHook(stopped, 7), { type: 'stopWithoutProcessing' })
})
