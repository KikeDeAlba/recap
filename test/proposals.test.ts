import assert from 'node:assert/strict'
import { readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { test } from 'node:test'
import { ProposalGenerator, ProposalReview, loadProposals, parseProposalPlan, proposalStore, type ProposalsFile } from '../src/bita/proposals.ts'
import { saveMeeting, type Meeting } from '../src/core/meeting.ts'
import { stageApplies, stageSatisfied, STAGES } from '../src/pipeline/stages.ts'
import { RecapError } from '../src/errors.ts'
import { FakeBita, meeting, tempDir } from './helpers.ts'

test('keeps only valid changes to candidate pages', () => {
  const answer = `Listo:
{"proposals": [
  {"pageId": 3, "section": "## Despliegue", "markdown": "## Despliegue\\nSe despliega con \`make release\`.", "title": "Actualizar el comando de despliegue", "rationale": "Se corrigió el comando.", "quotes": [{"startMs": 754000, "channel": "Sala", "text": "ya no es make deploy, es make release"}]},
  {"pageId": 3, "section": "Despliegue", "markdown": "Otra versión.", "title": "Duplicado", "rationale": "", "quotes": [{"startMs": 1, "channel": "mic", "text": "x"}]},
  {"pageId": 99, "section": null, "markdown": "x", "title": "Fuera", "rationale": "", "quotes": [{"startMs": 1, "channel": "mic", "text": "x"}]},
  {"pageId": "4", "section": null, "markdown": "Como se acordó en la reunión, el tope es 10 000.", "title": "Tope", "rationale": "", "quotes": [{"startMs": 1, "channel": "system", "text": "x"}]},
  {"pageId": 4, "section": "Límites", "markdown": "El tope por operación es de 10 000 MXN.", "title": "Subir el tope", "rationale": "", "quotes": []},
  {"pageId": 4, "section": "Límites", "markdown": "El tope por operación es de 10 000 MXN.", "title": "Subir el tope", "rationale": "Nuevo tope.", "quotes": [{"startMs": 90500.0, "channel": "Remotos", "text": "el tope pasó a diez mil"}]}
]}`
  const { drafts, discarded } = parseProposalPlan(answer, new Set([3, 4]))
  assert.equal(drafts.length, 2)
  assert.equal(drafts[0]?.section, 'Despliegue')
  assert.equal(drafts[0]?.markdown, 'Se despliega con `make release`.')
  assert.deepEqual(drafts[0]?.quotes, [{ startMs: 754_000, channel: 'mic', text: 'ya no es make deploy, es make release' }])
  assert.equal(drafts[1]?.quotes[0]?.channel, 'system')
  assert.equal(drafts[1]?.quotes[0]?.startMs, 90_500)
  assert.deepEqual(
    discarded.map((item) => item.index),
    [1, 2, 3, 4],
  )
  assert.ok(discarded[2]?.reason.includes('reveals'))
  assert.equal(parseProposalPlan('{"proposals": []}', new Set([1])).drafts.length, 0)
  assert.throws(() => parseProposalPlan('nada que proponer', new Set([1])), RecapError)
})

function setup(t: Parameters<typeof tempDir>[0], projectName: string | undefined = 'CoDi'): { dir: string; value: Meeting } {
  const dir = tempDir(t)
  const value = meeting({ status: 'processing', bitaEntryId: 42, bitaEntry: { title: 'Daily de CoDi', projectName, kind: 'remote-meeting', pageIds: [50, 7] } })
  saveMeeting(value, dir)
  writeFileSync(path.join(dir, 'transcript.md'), '**[00:12:34] Sala:** ya no es make deploy')
  return { dir, value }
}

function bita(applyConflict = false): FakeBita {
  let proposeCount = 0
  return new FakeBita((args) => {
    const head = args.slice(0, 3).join(' ')
    if (head === 'docs page ls') {
      return {
        ok: true,
        data: {
          pages: [
            { pageId: 3, title: 'Despliegue', relPath: 'codi/despliegue.md', depth: 0 },
            { pageId: 50, title: 'Daily', relPath: 'codi/daily.md', depth: 0 },
          ],
        },
        meta: { root: '/data/docs' },
      }
    }
    if (head === 'project repo ls') return { ok: true, data: { repos: [] } }
    if (head === 'docs page show') return { ok: true, data: { pageId: 7, title: 'Reglas de negocio', relPath: 'codi/reglas.md', projectName: 'CoDi' } }
    if (head === 'docs propose --branch') {
      proposeCount += 1
      return { ok: true, data: { branch: args[3], sha: `sha${proposeCount}`, pageId: Number(args[4]), base: 'main0' } }
    }
    if (head === 'docs branch apply') {
      if (applyConflict) return { ok: false, errorCode: 'MERGE_CONFLICT', errorMessage: 'conflict in codi/despliegue.md' }
      return { ok: true, data: { branch: args[3], sha: args[5], appliedSha: `main-${args[5]}` } }
    }
    if (head === 'docs branch drop') return { ok: true, data: { branch: args[3], dropped: true } }
    return { ok: false, errorCode: 'USAGE', errorMessage: `unexpected ${args.join(' ')}` }
  })
}

const ANSWER = `{"proposals": [
  {"pageId": 3, "section": "Despliegue", "markdown": "Se despliega con \`make release\`.", "title": "Actualizar el despliegue", "rationale": "Cambió el comando.", "quotes": [{"startMs": 754000, "channel": "mic", "text": "ya no es make deploy"}]},
  {"pageId": 50, "section": null, "markdown": "x", "title": "Propia", "rationale": "", "quotes": [{"startMs": 1, "channel": "mic", "text": "x"}]},
  {"pageId": 7, "section": "Límites", "markdown": "El tope es de 10 000 MXN.", "title": "Subir el tope", "rationale": "Nuevo tope.", "quotes": [{"startMs": 9000, "channel": "system", "text": "diez mil"}]}
]}`

async function generate(fake: FakeBita, value: Meeting, dir: string): Promise<{ file: ProposalsFile | null; prompt: string }> {
  let prompt = ''
  const generator = new ProposalGenerator({}, fake, () => undefined, async (text, dirs) => {
    prompt = text
    assert.deepEqual(dirs, ['/data/docs', dir])
    return ANSWER
  })
  return { file: await generator.run(value, dir), prompt }
}

test('proposes each change on the meeting branch', async (t) => {
  const { dir, value } = setup(t)
  const fake = bita()
  const { file, prompt } = await generate(fake, value, dir)
  assert.ok(file)
  assert.ok(prompt.includes(`#3 «Despliegue» — ${path.join('/data/docs', 'codi/despliegue.md')}`))
  assert.ok(prompt.includes('#7 «Reglas de negocio»'))
  assert.ok(!prompt.includes('#50'))
  assert.ok(!prompt.includes('{{'))
  assert.equal(file.branch, 'proposal/meeting-42')
  assert.deepEqual(
    file.proposals.map((item) => item.pageId),
    [3, 7],
  )
  assert.deepEqual(
    file.proposals.map((item) => item.sha),
    ['sha1', 'sha2'],
  )
  assert.equal(file.discarded.length, 1)
  const propose = fake.calls.find((call) => call[0] === 'docs' && call[1] === 'propose')
  assert.deepEqual(propose, ['docs', 'propose', '--branch', 'proposal/meeting-42', '3', '--md', proposalStore.markdownFile(dir, 1), '--section', 'Despliegue', '--reason', 'Actualizar el despliegue', '--source', 'meeting:42'])
  assert.equal(readFileSync(proposalStore.markdownFile(dir, 1), 'utf8'), 'Se despliega con `make release`.\n')
  assert.deepEqual(
    loadProposals(dir)?.proposals.map((item) => item.sha),
    ['sha1', 'sha2'],
  )
  assert.ok(readFileSync(proposalStore.file(dir), 'utf8').includes('"section" : "Despliegue"'))
})

test('takes the project from the meeting page when the entry had none', async (t) => {
  const { dir, value } = setup(t, undefined)
  const fake = bita()
  const { file } = await generate(fake, value, dir)
  assert.ok(fake.calls.some((call) => call.join(' ') === 'docs page ls --project CoDi'))
  assert.deepEqual(
    file?.proposals.map((item) => item.pageId),
    [3, 7],
  )
})

test('accept applies and reject drops the branch when nothing is pending', async (t) => {
  const { dir, value } = setup(t)
  const fake = bita()
  await generate(fake, value, dir)
  const review = new ProposalReview(dir, fake)
  const accepted = await review.accept(1)
  assert.equal(accepted.status, 'accepted')
  assert.equal(accepted.appliedSha, 'main-sha1')
  assert.ok(!fake.calls.some((call) => call.slice(0, 3).join(' ') === 'docs branch drop'))
  await assert.rejects(review.accept(1), RecapError)
  const rejected = await review.reject(2)
  assert.equal(rejected.status, 'rejected')
  assert.deepEqual(fake.calls.at(-1), ['docs', 'branch', 'drop', 'proposal/meeting-42'])
  assert.equal(loadProposals(dir)?.branchDropped, true)
  await assert.rejects(review.reject(9), RecapError)
})

test('a conflict leaves the proposal stale and an edit proposes again', async (t) => {
  const { dir, value } = setup(t)
  await generate(bita(), value, dir)
  const stale = await new ProposalReview(dir, bita(true)).accept(1)
  assert.equal(stale.status, 'stale')
  const edited = path.join(dir, 'edited.md')
  writeFileSync(edited, 'Se despliega con `make release-prod`.\n')
  const fake = bita()
  const accepted = await new ProposalReview(dir, fake).accept(1, edited)
  assert.equal(accepted.status, 'accepted')
  assert.equal(accepted.sha, 'sha1')
  assert.deepEqual(fake.calls[0]?.slice(0, 5), ['docs', 'propose', '--branch', 'proposal/meeting-42', '3'])
  assert.deepEqual(fake.calls[1], ['docs', 'branch', 'apply', 'proposal/meeting-42', '--commit', 'sha1'])
  assert.ok(readFileSync(proposalStore.markdownFile(dir, 1), 'utf8').includes('release-prod'))
})

test('regeneration keeps reviewed proposals', async (t) => {
  const { dir, value } = setup(t)
  const fake = bita()
  await generate(fake, value, dir)
  await new ProposalReview(dir, fake).reject(1)
  const generator = new ProposalGenerator({}, fake, () => undefined, async () => {
    throw new Error('claude must not run again')
  })
  const again = await generator.run(value, dir)
  assert.equal(again?.proposals[0]?.status, 'rejected')
})

test('the stage is optional and only for bita meetings', () => {
  const value = meeting({ mode: 'in-person', status: 'recorded' })
  assert.ok(!stageApplies('proposals', value))
  assert.ok(stageApplies('proposals', { ...value, bitaEntryId: 1 }))
  const failed = { status: 'failed', updatedAt: '2026-01-01T00:00:00Z', error: 'boom' }
  assert.ok(stageSatisfied('proposals', failed))
  assert.ok(!stageSatisfied('wrapup', failed))
  assert.ok(STAGES.indexOf('proposals') < STAGES.indexOf('wrapup'))
  assert.ok(STAGES.indexOf('proposals') > STAGES.indexOf('transcribe'))
})
