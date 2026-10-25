import assert from 'node:assert/strict'
import { test } from 'node:test'
import { isGenericTitle, noteBody } from '../src/bita/wrapup.ts'
import { defaultTitle } from '../src/capture/recording.ts'
import { meetingLabel, modeLabel, modality } from '../src/core/meeting.ts'
import { renderSummaryPrompt } from '../src/pipeline/summary.ts'
import { meetingHeader } from '../src/pipeline/transcript.ts'
import { meeting } from './helpers.ts'

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
