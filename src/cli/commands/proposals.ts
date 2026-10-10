import { loadConfig, type Config } from '../../core/config.ts'
import { expandTilde } from '../../core/paths.ts'
import { readText } from '../../core/fsutil.ts'
import { MeetingStore, resolveTarget, type Located } from '../../core/meeting.ts'
import { RecapError, usageError } from '../../errors.ts'
import { INKWELL_CAPABILITIES, INKWELL_HINT, findInkwell, requireInkwell, type ToolCalling } from '../../bita/client.ts'
import { ProposalReview, loadProposals, proposalJson, type Proposal } from '../../bita/proposals.ts'
import { parseArgs, type Args } from '../args.ts'
import { output } from '../output.ts'

function line(proposal: Proposal): string {
  const section = proposal.section !== null ? ` › ${proposal.section}` : ''
  return `${proposal.n}. [${proposal.status}] ${proposal.pageTitle}${section}: ${proposal.title}`
}

function meeting(args: Args, config: Config): Located {
  const bitaEntry = args.int('bita-entry')
  return resolveTarget(new MeetingStore(config), bitaEntry === undefined ? args.positionals[0] : undefined, bitaEntry)
}

function number(args: Args): number {
  const raw = args.value('bita-entry') === undefined ? args.positionals[1] : args.positionals[0]
  if (raw === undefined || !/^\d+$/.test(raw)) throw new RecapError('PROPOSAL_REQUIRED', 'Pass the proposal number')
  return Number(raw)
}

const noInkwell: ToolCalling = { invoke: async () => ({ ok: false, errorCode: 'DEPENDENCY_MISSING', errorMessage: `inkwell not found (${INKWELL_HINT})` }) }

async function review(args: Args, config: Config, required: boolean): Promise<ProposalReview> {
  const found = meeting(args, config)
  const inkwell = required ? await requireInkwell(INKWELL_CAPABILITIES.proposals, 'Reviewing proposals') : await findInkwell(INKWELL_CAPABILITIES.proposals)
  return new ProposalReview(found.dir, inkwell ?? noInkwell)
}

export async function proposalsCommand(argv: string[]): Promise<number> {
  const [sub, ...rest] = argv
  const json = rest.includes('--json')
  const spec = { values: ['bita-entry', ...(sub === 'accept' ? ['md'] : [])], maxPositionals: 2 }
  switch (sub) {
    case 'ls':
      return output('proposals ls', json, () => {
        const args = parseArgs(rest, spec)
        const proposals = loadProposals(meeting(args, loadConfig()).dir)?.proposals ?? []
        return { data: { proposals: proposals.map(proposalJson) }, text: proposals.length === 0 ? 'No proposals' : proposals.map(line).join('\n') }
      })
    case 'show':
      return output('proposals show', json, async () => {
        const args = parseArgs(rest, spec)
        const reviewer = await review(args, loadConfig(), false)
        const proposal = reviewer.proposal(number(args))
        const markdown = readText(proposal.file)
        const diff = proposal.status === 'pending' || proposal.status === 'stale' ? await reviewer.diff(proposal) : null
        let text = `${line(proposal)}\n\n${proposal.rationale}`
        if (markdown !== null) text += `\n\n${markdown}`
        return { data: { proposal: proposalJson(proposal), markdown: markdown ?? undefined, diff: diff ?? undefined }, text }
      })
    case 'accept':
      return output('proposals accept', json, async () => {
        const args = parseArgs(rest, spec)
        const reviewer = await review(args, loadConfig(), true)
        const md = args.value('md')
        const proposal = await reviewer.accept(number(args), md === undefined ? undefined : expandTilde(md))
        const text = proposal.status === 'stale' ? `Proposal ${proposal.n} conflicts with the current page; it is now stale` : `Applied proposal ${proposal.n} to ${proposal.pageTitle}`
        return { data: { proposal: proposalJson(proposal) }, text }
      })
    case 'reject':
      return output('proposals reject', json, async () => {
        const args = parseArgs(rest, spec)
        const reviewer = await review(args, loadConfig(), true)
        const proposal = await reviewer.reject(number(args))
        return { data: { proposal: proposalJson(proposal) }, text: `Rejected proposal ${proposal.n}` }
      })
    default:
      return output('proposals', argv.includes('--json'), () => {
        throw usageError('Usage: recap proposals ls|show|accept|reject <meeting> [n] [--bita-entry id]')
      })
  }
}
