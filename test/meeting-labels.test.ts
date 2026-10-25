import assert from 'node:assert/strict'
import { test } from 'node:test'
import { isGenericTitle, noteBody } from '../src/bita/wrapup.ts'
import { defaultTitle } from '../src/capture/recording.ts'
import { meetingLabel, modeLabel, modality } from '../src/core/meeting.ts'
import { renderSummaryPrompt } from '../src/pipeline/summary.ts'
import { meetingHeader } from '../src/pipeline/transcript.ts'
import { meeting, tempDir } from './helpers.ts'
import { recordingLine, startText } from '../src/cli/commands/recording.ts'
import { planWrapup } from '../src/bita/wrapup.ts'
import { emptyContext } from '../src/live/context.ts'
import { START_CURSOR, detectorBatch, renderDetectPrompt } from '../src/live/detector.ts'

test('a meeting has no modality while the old modes keep theirs', () => {
  assert.equal(modality('meeting'), null)
  assert.equal(modality('remote'), 'remota')
  assert.equal(modality('in-person'), 'presencial')
  assert.equal(meetingLabel('meeting'), 'reunión')
  assert.equal(meetingLabel('in-person'), 'reunión presencial')
  assert.equal(modeLabel('meeting'), 'reunión')
})

test('meeting texts name a meeting without a modality and the default title stays generic', () => {
  assert.ok(isGenericTitle(defaultTitle('meeting')))
  const value = meeting({ mode: 'meeting', startedAt: '2026-10-24T10:00:00Z', endedAt: '2026-10-24T10:30:00Z' })
  assert.match(meetingHeader(value), / · reunión$/)
  assert.match(meetingHeader(meeting({ mode: 'in-person' })), / · reunión presencial$/)
  const note = noteBody('## Resumen\nAvance.', value, '/tmp/m')
  assert.match(note, /^Minuta de la reunión \(/)
  assert.ok(!note.includes('presencial'))
  const prompt = renderSummaryPrompt(value, 'texto', [], '{{mode}}')
  assert.equal(prompt, 'reunión')
})

test('the summary prompt and header keep the wording of the two old modes', () => {
  assert.equal(renderSummaryPrompt(meeting({ mode: 'remote' }), 'texto', [], '{{mode}}'), 'remota (videollamada)')
  assert.equal(renderSummaryPrompt(meeting({ mode: 'in-person' }), 'texto', [], '{{mode}}'), 'presencial')
  assert.match(meetingHeader(meeting({ mode: 'remote' })), / · reunión remota$/)
  const speakers = (mode: 'remote' | 'in-person' | 'meeting') => renderSummaryPrompt(meeting({ mode }), 'texto', [], '{{speakers}}')
  assert.match(speakers('remote'), /«Remotos»/)
  assert.doesNotMatch(speakers('meeting'), /Remotos/)
  assert.equal(speakers('meeting'), speakers('in-person'))
})

test('the default titles are English, distinct per mode and treated as generic', () => {
  assert.deepEqual(['remote', 'in-person', 'meeting'].map((mode) => defaultTitle(mode as 'remote')), ['Remote meeting', 'In-person meeting', 'Meeting'])
  for (const mode of ['remote', 'in-person', 'meeting'] as const) assert.ok(isGenericTitle(defaultTitle(mode)))
})

test('a meeting that fell back to in-person carries no modality in labels, minutes and prompts', () => {
  const fallback = meeting({ mode: 'in-person', fallback: 'in-person', startedAt: '2026-10-24T10:00:00Z', endedAt: '2026-10-24T10:30:00Z' })
  assert.equal(modality(fallback), null)
  assert.equal(modality({ mode: 'in-person' }), 'presencial')
  assert.equal(meetingLabel(fallback), 'reunión')
  assert.equal(modeLabel(fallback), 'reunión')
  assert.match(meetingHeader(fallback), / · reunión$/)
  const note = noteBody('## Resumen\nAvance.', fallback, '/tmp/m')
  assert.match(note, /^Minuta de la reunión \(/)
  assert.ok(!note.includes('presencial'))
  assert.equal(renderSummaryPrompt(fallback, 'texto', [], '{{mode}}'), 'reunión')
})

test('the wrap-up and detector prompts of a fallback meeting carry no modality', async (t) => {
  const fallback = meeting({ mode: 'in-person', fallback: 'in-person', startedAt: '2026-10-24T10:00:00Z', endedAt: '2026-10-24T10:30:00Z' })
  let prompt = ''
  await planWrapup(fallback, tempDir(t), { title: 'Reunión', pageIds: [] }, [], null, async (text) => {
    prompt = text
    return '{"title":"Tema","project":null,"pageTitle":"Tema","pageMarkdown":"## A\\nB","backlog":[]}'
  })
  assert.match(prompt, /Modo: reunión\n/)
  assert.ok(!prompt.includes('presencial'))
  const detect = renderDetectPrompt('{{speakers}}', fallback, emptyContext(), detectorBatch([], START_CURSOR), [])
  assert.match(detect, /^Es una reunión con un solo micrófono/)
})

test('the start and status lines name the mode once and never a fallback modality', () => {
  assert.equal(recordingLine(meeting({ mode: 'meeting', title: 'Daily' })), 'Recording meeting "Daily"')
  assert.equal(recordingLine(meeting({ mode: 'remote', title: 'Daily' })), 'Recording remote meeting "Daily"')
  assert.equal(recordingLine(meeting({ mode: 'in-person', title: 'Daily' })), 'Recording in-person meeting "Daily"')
  assert.equal(recordingLine(meeting({ mode: 'in-person', fallback: 'in-person', title: 'Daily' })), 'Recording meeting "Daily"')
  assert.equal(startText(meeting({ mode: 'meeting', title: 'Daily' }), '/m'), 'Recording meeting "Daily"\n/m')
  assert.equal(
    startText(meeting({ mode: 'in-person', fallback: 'in-person', title: 'Daily' }), '/m'),
    'Recording meeting "Daily"\nRecap.app does not support meeting mode yet; recording the microphone only. Update it with `recap setup`.\n/m',
  )
})
