/** Merge request binding, lifecycle observation, and terminal IM notification helpers. */
import { key, liveTicket, type Follow, type OutboundMessage, type ThreadFact, type ThreadRef, type Ticket } from '../core/index.ts'
import type { Deployment } from '../deployment.ts'
import { sameName } from '../infra/text.ts'
import type { SourceContext } from './host.ts'
import { gitlabPage, gitlabThread, MergeRequestSchema, SOURCE, threadRef, type GitlabMergeRequest } from './gitlab-trigger.ts'

/** The Thread key of a merge request, `gitlab:mr:<iid>`, which Triggers, Channels, and descriptions all use. */
const mergeRequestThread = (number: number): string => gitlabThread('mergeRequest', number)
/** The Thread a ticket follows for a merge request; its id completes the Source to `gitlab:mr:<iid>`. */
const mergeRequestRef = (number: number): ThreadRef => ({ source: SOURCE, id: `mr:${number}` })
/** Reads the merge request number out of a followed Thread key, `gitlab:mr:<iid>` or a number-only `gitlab:<iid>`; an Issue yields none. */
const mergeRequestNumber = (thread: string): number | undefined => {
  const ref = threadRef(thread)
  return ref && ref.kind !== 'issue' ? ref.number : undefined
}
/**
 * Reads one merge request of the configured project by its project-wide number (`iid`).
 * @throws CliError with GitLab's HTTP status as `code` when the API call fails.
 */
export const readMergeRequest = async (ctx: SourceContext, number: number,
  signal?: AbortSignal): Promise<GitlabMergeRequest & { number: number }> => {
  const path = `projects/${ctx.commands.gitlabProject}/merge_requests/${number}`
  return { ...await ctx.commands.withSignal(signal).gitlabApi(MergeRequestSchema, path), number }
}
/** The merge requests a ticket follows, in the order it followed them; `open` keeps only those not closed yet. */
export const mergeRequestsOf = (ticket: Pick<Ticket, 'follows'>, open = false): number[] =>
  (ticket.follows ?? []).filter(item => !open || !item.closed).flatMap(item => mergeRequestNumber(item.thread) ?? [])
/** The merge request a ticket currently follows: the last one still open, else the last one closed. */
export const mergeRequestOf = (ticket: Pick<Ticket, 'follows'>): number | undefined =>
  mergeRequestsOf(ticket, true).at(-1) ?? mergeRequestsOf(ticket).at(-1)
/** True when the merge request was opened by the agent account from a branch in the configured project (not a fork). */
export const agentMergeRequest = (mr: Pick<GitlabMergeRequest, 'author' | 'source_project_id'>,
  deployment: Pick<Deployment, 'gitlab'>): boolean =>
  sameName(mr.author.username, deployment.gitlab!.login) && mr.source_project_id === deployment.gitlab!.projectId
/** True when a branch belongs to the ticket: its last path segment is the ticket's short name, such as `agent/<name>`. */
export const ticketBranch = (ticket: Pick<Ticket, 'execution'>, ref: string): boolean =>
  !!ticket.execution?.name && ref.split('/').at(-1) === ticket.execution.name
/**
 * Validates and binds an open merge request to a ticket when it is either the ticket's origin merge request or an agent-authored
 * merge request on the ticket's branch, enforcing that one merge request binds to at most one open ticket.
 * Returns an error message when binding is rejected, or undefined when the merge request is bound or not open (which is not an error).
 */
export function claimMergeRequest(ctx: SourceContext, ticketId: string, mr: GitlabMergeRequest): string | undefined {
  const ticket = ctx.tickets.get(ticketId)
  if (!ticket || !liveTicket(ticket)) return 'Ticket ended because its merge request was closed'
  const source = ctx.triggers.get(ticket.origin.triggerId)
  const started = source?.source === SOURCE && source.meta.isMr === true && source.meta.number === mr.iid
  const opened = agentMergeRequest(mr, ctx.deployment) && ticketBranch(ticket, mr.source_branch)
  if (!started && !opened) {
    const { login } = ctx.deployment.gitlab!
    return `Merge request does not belong to this ticket: use the source merge request or a merge request by ${login} from`
      + ' a branch whose last path segment is DSH_SUPERAGENT_NAME; omit mr_iid when no merge request exists'
  }
  const owner = ctx.tickets.open().find(item => mergeRequestsOf(item, true).includes(mr.iid))
  if (owner && owner.id !== ticketId) return 'Merge request already belongs to another active ticket'
  const follow = ticket.follows?.find(item => item.thread === mergeRequestThread(mr.iid))
  if (mr.state === 'opened' && (!follow || follow.closed || (opened && !follow.own))) bind(ctx, ticketId, mr, opened)
  return undefined
}
/**
 * Reconciles a polled merge request's open/merged/closed state and pipeline fact with any bound or branch-matching ticket.
 * An open agent merge request auto-binds to the single open ticket on its branch unless that ticket already follows another open
 * merge request (which only the Executor's report changes).
 * @returns whether the merge request has ended.
 */
export async function observeMergeRequest(ctx: SourceContext, mr: GitlabMergeRequest): Promise<boolean> {
  const ended = mr.state === 'closed' || mr.state === 'merged'
  if (ended) closeMergeRequest(ctx, mr)
  else {
    const candidates = agentMergeRequest(mr, ctx.deployment)
      ? ctx.tickets.open().filter(ticket => ticketBranch(ticket, mr.source_branch))
      : []
    const ticket = candidates.length === 1 ? candidates[0]! : undefined
    // A merge request the ticket followed until it closed, and that is open again, is followed again.
    const reopened = ticket?.follows?.some(item => item.thread === mergeRequestThread(mr.iid) && item.closed)
    if (ticket && (reopened || mergeRequestsOf(ticket, true).every(number => number === mr.iid))) claimMergeRequest(ctx, ticket.id, mr)
  }
  ctx.threads.describe(mergeRequestThread(mr.iid), { facts: { pipeline: !ended ? pipelineFact(mr) : null } })
  return ended
}
/** The merge request's pipeline status as a displayed fact, or null when GitLab reports no pipeline. */
const pipelineFact = (mr: GitlabMergeRequest): ThreadFact | null => {
  const status = mr.pipeline?.status ?? mr.head_pipeline?.status
  return status ? { label: { zh: '流水线', en: 'Pipeline' }, value: status } : null
}
function bind(ctx: SourceContext, ticketId: string, mr: GitlabMergeRequest, own: boolean): void {
  ctx.atomic(() => {
    ctx.tickets.bindThread(ticketId, mergeRequestRef(mr.iid), own)
    ctx.threads.patch(mergeRequestThread(mr.iid), { number: mr.iid, isMr: true, url: mr.web_url, itemAuthor: mr.author.username })
  })
}
/**
 * Reports a merged or closed merge request once to the open tickets that follow it, whose end the core decides.
 * Their subscription to the merge request stays so a later human comment there resumes the ticket.
 */
function closeMergeRequest(ctx: SourceContext, mr: GitlabMergeRequest): void {
  if (!ctx.tickets.open().some(ticket => mergeRequestsOf(ticket, true).includes(mr.iid))) return
  const at = mr.merged_at ?? mr.closed_at ?? new Date().toISOString()
  ctx.tickets.threadClosed(mergeRequestRef(mr.iid), mr.merged ? 'merged' : 'closed', at)
}
/**
 * Builds idempotent outbound notices for IM conversations when a ticket ends with its merge request (selecting the last-closed
 * merge request it opened, else the last one it followed). The notice language follows the ticket's source request: Chinese when
 * it contains Han characters and no kana, otherwise English.
 */
export function mergeRequestEndNotices(ticket: Ticket, request: string, deployment: Pick<Deployment, 'gitlab'>): OutboundMessage[] {
  const outcome = ticket.ended?.outcome
  const follows = (ticket.follows ?? []).filter(item => item.closed && mergeRequestNumber(item.thread) !== undefined)
  const latest = (items: Follow[]) => items.sort((a, b) => b.closed!.at.localeCompare(a.closed!.at))[0]
  const follow = latest(follows.filter(item => item.own)) ?? latest(follows)
  if ((outcome !== 'merged' && outcome !== 'closed') || !follow) return []
  const gitlab = deployment.gitlab!
  const number = mergeRequestNumber(follow.thread)!
  const url = gitlabPage(gitlab.url, gitlab.project, number, 'mergeRequest')
  const chinese = /\p{Script=Han}/u.test(request) && !/[\p{Script=Hiragana}\p{Script=Katakana}]/u.test(request)
  const text = chinese
    ? outcome === 'merged' ? `[MR !${number}](${url}) 已合并。` : `[MR !${number}](${url}) 已关闭，未合并。`
    : outcome === 'merged' ? `[MR !${number}](${url}) has merged.` : `[MR !${number}](${url}) was closed without merging.`
  // GitLab's merge request page already shows the merge or closure, so GitLab channels are skipped.
  return ticket.channels.filter(channel => channel.source !== SOURCE).map(channel => ({
    id: key('mr-terminal', String(number), channel.source, JSON.stringify(channel.address), outcome),
    channel, text, kind: 'notice', ticketId: ticket.id }))
}
