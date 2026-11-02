/** Read-only GitLab project, conversation, and pipeline inspection for assessments and workers. */
import { z } from 'zod'
import type { ThreadFact } from '../core/index.ts'
import { validItems, type Commands, type Tally } from '../infra/commands.ts'
import { ItemSchema, MergeRequestSchema, NoteSchema, notePlace, isHumanLogin, threadRef, type GitlabNote } from './gitlab-trigger.ts'
import type { ContextMessage, ThreadContext } from './kind.ts'

const PipelineSchema = z.looseObject({ id: z.number().nullish(), status: z.string(), sha: z.string().nullish(), ref: z.string().nullish(),
  web_url: z.string().nullish(), created_at: z.string().nullish(), updated_at: z.string().nullish() })
export type Pipeline = z.infer<typeof PipelineSchema>
const StatusSchema = z.looseObject({ status: z.string(), name: z.string().nullish(), sha: z.string().nullish() })
type Status = z.infer<typeof StatusSchema>
/** Pipeline states that count as a failure; `success`, `skipped`, `manual`, `canceled` and `created` do not. */
const FAILING = new Set(['failed'])
const RUNNING = new Set(['running', 'pending', 'preparing', 'waiting_for_resource', 'created', 'scheduled'])
export interface CiSnapshot { head: string; pipelines: Pipeline[]; statuses: Status[] }
export function ciCounts(snapshot: CiSnapshot): { failed: number; running: number } {
  const latest = [...snapshot.pipelines].sort((a, b) => (b.id ?? 0) - (a.id ?? 0)).slice(0, 1)
  return { failed: latest.filter(pipeline => FAILING.has(pipeline.status)).length + snapshot.statuses.filter(status => FAILING.has(status.status)).length,
    running: latest.filter(pipeline => RUNNING.has(pipeline.status)).length + snapshot.statuses.filter(status => RUNNING.has(status.status)).length }
}
/** Summarizes the pipelines and commit statuses of one commit for a model-facing Trigger. */
export function ciSummary(snapshot: CiSnapshot, where: string, read: string): string {
  const latest = [...snapshot.pipelines].sort((a, b) => (b.id ?? 0) - (a.id ?? 0))[0]
  const statuses = snapshot.statuses.map(status => ({ name: status.name ?? 'status', failed: FAILING.has(status.status), running: RUNNING.has(status.status) }))
  const failed = statuses.filter(status => status.failed).map(status => status.name)
  const running = statuses.filter(status => status.running).map(status => status.name)
  const names = (list: string[]) => list.slice(0, 5).join(', ') + (list.length > 5 ? `, and ${list.length - 5} more` : '')
  const at = `on ${where} at ${snapshot.head.slice(0, 7)}`
  if (latest?.status === 'failed') return `CI failed ${at}: pipeline ${latest.id ?? 'unknown'}${failed.length ? `, ${names(failed)}` : ''}\nRead ${read} for the pipelines.`
  if (latest && RUNNING.has(latest.status)) return `CI running ${at}: pipeline ${latest.id ?? 'unknown'}\nRead ${read} for the pipelines.`
  if (failed.length) return `CI failed ${at}: ${names(failed)}\nRead ${read} for the statuses.`
  if (running.length) return `CI running ${at}: ${names(running)}\nRead ${read} for the statuses.`
  return `CI passed ${at}${latest ? ` (pipeline ${latest.id ?? 'unknown'})` : ''}\nRead ${read} for the pipelines.`
}
/** A Thread fact for the current pipeline state of a merge request or a branch. */
export function ciFact(snapshot: CiSnapshot): ThreadFact {
  const counts = ciCounts(snapshot)
  const failed = FAILING.has([...snapshot.pipelines].sort((a, b) => (b.id ?? 0) - (a.id ?? 0))[0]?.status ?? '')
  if (failed || counts.failed) return { label: { zh: 'CI 失败', en: 'CI failed' }, value: String(Math.max(counts.failed, 1)), problem: true }
  if (counts.running) return { label: { zh: 'CI 进行中', en: 'CI running' }, value: String(counts.running) }
  return { label: 'CI', value: { zh: '通过', en: 'passed' } }
}
export function ciFailures(snapshot: CiSnapshot): string[] {
  return [...snapshot.pipelines.filter(pipeline => FAILING.has(pipeline.status)).map(pipeline => pipeline.id != null ? `pipeline ${pipeline.id}` : 'pipeline'),
    ...snapshot.statuses.filter(status => FAILING.has(status.status)).map(status => status.name ?? 'status')].sort()
}
/** Reads whether a merge request may merge on GitLab 13.1: open, conflict-free, mergeable by state, and its pipeline passed. */
export function mergeable(mr: z.infer<typeof MergeRequestSchema>): { ok: boolean; reason: string } {
  const pipeline = mr.head_pipeline ?? mr.pipeline ?? undefined
  if (mr.state !== 'opened') return { ok: false, reason: `the merge request is ${mr.state}` }
  if (mr.has_conflicts === true) return { ok: false, reason: 'it has conflicts' }
  if (mr.merge_status && mr.merge_status !== 'can_be_merged') return { ok: false, reason: `GitLab reports ${mr.merge_status}` }
  if (pipeline && pipeline.status !== 'success' && pipeline.status !== 'skipped' && pipeline.status !== 'manual') {
    return { ok: false, reason: `its pipeline is ${pipeline.status}` }
  }
  return { ok: true, reason: 'it is open, conflict-free, and its pipeline passed' }
}
/** Reads a non-hidden file or directory listing from the project's default branch; hidden entries and `node_modules` are rejected. */
export async function readRepositoryPath(commands: Commands, path: string, kind: 'file' | 'directory'): Promise<string> {
  const parts = path.split('/').filter(part => part && part !== '.')
  if (parts.some(part => part === '..' || part.startsWith('.') || part === 'node_modules')) throw new Error('Only non-hidden repository source paths are available')
  const project = commands.gitlabProject
  const encoded = parts.map(encodeURIComponent).join('%2F')
  if (kind === 'file') return commands.gitlabRaw(`projects/${project}/repository/files/${encoded}/raw?ref=${encodeURIComponent(await defaultBranch(commands))}`)
  const entries = await commands.gitlabPages(z.looseObject({ name: z.string(), type: z.string().nullish() }),
    `projects/${project}/repository/tree?path=${encodeURIComponent(parts.join('/'))}&per_page=100`)
  return entries.filter(entry => !entry.name.startsWith('.') && entry.name !== 'node_modules').map(entry => entry.name).sort().join('\n')
}
/** Reads the project's default branch, which a repository path is read from when the caller names none. */
async function defaultBranch(commands: Commands): Promise<string> {
  const project = await commands.gitlabApi(z.looseObject({ default_branch: z.string().nullish() }), `projects/${commands.gitlabProject}`)
  return project.default_branch ?? 'master'
}
/** Reads a commit's pipelines and statuses without emitting a trigger. */
export async function commitCi(commands: Commands, sha: string, tally?: Tally): Promise<CiSnapshot> {
  const pipelines = await commands.gitlabPages(PipelineSchema, `projects/${commands.gitlabProject}/pipelines?sha=${encodeURIComponent(sha)}&per_page=100`, tally)
  const statuses = await commands.gitlabPages(StatusSchema, `projects/${commands.gitlabProject}/repository/commits/${encodeURIComponent(sha)}/statuses?per_page=100`, tally)
  return { head: sha, pipelines, statuses }
}
/** Reads the pipelines of a merge request, newest first, as the merge gate and the CI Trigger see them. */
export async function mergeRequestCi(commands: Commands, number: number, tally?: Tally): Promise<CiSnapshot> {
  const pipelines = await commands.gitlabPages(PipelineSchema,
    `projects/${commands.gitlabProject}/merge_requests/${number}/pipelines?per_page=100`, tally)
  const head = [...pipelines].sort((a, b) => (b.id ?? 0) - (a.id ?? 0))[0]?.sha ?? ''
  const statuses = head ? await commands.gitlabPages(StatusSchema,
    `projects/${commands.gitlabProject}/repository/commits/${encodeURIComponent(head)}/statuses?per_page=100`, tally) : []
  return { head, pipelines, statuses }
}
/** Formats a GitLab note as a model-facing ContextMessage, marking bots because bot messages never authorize work. */
function noteMessage(item: GitlabNote, text: string, id: string, url?: string, place?: string): ContextMessage {
  const line = item.position?.new_line ?? item.position?.old_line ?? undefined
  return { id, from: item.author.username, at: item.created_at ?? item.updated_at ?? '', text,
    ...!isHumanLogin(item.author) ? { bot: true } : {}, ...url ? { url } : {},
    ...place ? { path: item.position?.new_path ?? item.position?.old_path ?? undefined, ...line != null ? { line } : {} } : {} }
}
const noteUrl = (base: string, id: number): string => `${base}#note_${id}`
/** Reads one discussion of a merge request as messages, marking the first note as the root of the thread. */
function discussionMessages(discussion: { id: string; notes: GitlabNote[] }, base: string): ContextMessage[] {
  const notes = [...discussion.notes].sort((a, b) => (a.created_at ?? '').localeCompare(b.created_at ?? ''))
  const [first] = notes
  return notes.map(note => note === first
    ? noteMessage(note, [notePlace(note), note.body ?? ''].filter(Boolean).join('\n\n'), noteUrl(base, note.id), noteUrl(base, note.id), notePlace(note))
    : { ...noteMessage(note, note.body ?? '', noteUrl(base, note.id), noteUrl(base, note.id)), ...first ? { reply_to: noteUrl(base, first.id) } : {} })
}
/** Reads the discussion a note belongs to, by reading the merge request's discussions and keeping that one. */
async function discussionOf(commands: Commands, number: number, note: number): Promise<{ id: string; notes: GitlabNote[] } | undefined> {
  const discussions = await commands.gitlabPages(z.looseObject({ id: z.string(), notes: z.array(z.unknown()) }),
    `projects/${commands.gitlabProject}/merge_requests/${number}/discussions?per_page=100`)
  for (const discussion of discussions) {
    const notes = validItems(NoteSchema, discussion.notes)
    if (notes.some(item => item.id === note)) return { id: discussion.id, notes }
  }
  return undefined
}
/**
 * Reads an Issue, a merge request, a page of its notes or discussions, one discussion thread, or a commit's pipelines as
 * model-facing `{ id, from, at, text, reply_to?, path?, line?, url }` messages rather than raw GitLab API records.
 */
export async function readGitlab(commands: Commands, resource: string): Promise<unknown> {
  const commit = /^gitlab\/commits\/([0-9a-f]{7,40})\/pipelines$/.exec(resource)
  if (commit) return commitCi(commands, commit[1]!)
  const match = /^gitlab\/(issues|merge_requests)\/([1-9]\d*)(?:\/(notes|discussions|thread|pipelines)(?:\/([A-Za-z0-9-]+|\d+))?)?$/.exec(resource)
  if (!match) throw new Error('Use gitlab/issues/<iid>, gitlab/merge_requests/<iid>, or append /notes/<page>, /discussions/<page>, /thread/<discussion-id> or /pipelines; or gitlab/commits/<sha>/pipelines')
  const [, kind, number, section, argument] = match
  const project = commands.gitlabProject
  const issue = kind === 'issues'
  if (issue && (section === 'discussions' || section === 'thread' || section === 'pipelines')) {
    throw new Error('Discussions and pipelines require a merge request')
  }
  if (section === 'pipelines') {
    if (argument) throw new Error('Pipelines do not take a page number')
    return mergeRequestCi(commands, Number(number))
  }
  const path = issue ? `projects/${project}/issues/${number}` : `projects/${project}/merge_requests/${number}`
  if (section === 'thread') {
    if (!argument) throw new Error('Name the discussion by its id: gitlab/merge_requests/<iid>/thread/<discussion-id>')
    const discussion = await discussionOf(commands, Number(number), Number(argument))
    if (!discussion) {
      const discussions = await commands.gitlabPages(z.looseObject({ id: z.string(), notes: z.array(z.unknown()) }),
        `projects/${project}/merge_requests/${number}/discussions?per_page=100`)
      const named = discussions.find(item => item.id === argument)
      if (!named) throw new Error('No discussion of this merge request has that id')
      return { messages: discussionMessages({ id: named.id, notes: validItems(NoteSchema, named.notes) }, '') }
    }
    return { messages: discussionMessages(discussion, '') }
  }
  if (!section) {
    const item = issue ? await commands.gitlabApi(ItemSchema, path) : await commands.gitlabApi(MergeRequestSchema, path)
    const branches = 'source_branch' in item ? { source_branch: item.source_branch, target_branch: item.target_branch } : {}
    const labels = item.labels?.length ? { labels: item.labels.map(label => typeof label === 'string' ? label : label.name) } : {}
    return { number: item.iid, title: item.title, state: item.state, ...'merged' in item && item.merged ? { merged: true } : {},
      ...'draft' in item && item.draft ? { draft: true } : {}, ...branches, ...labels,
      ...noteMessage(item, item.description ?? '', item.web_url, item.web_url) }
  }
  const page = Number(argument ?? '1')
  if (section === 'discussions') {
    const discussions = await commands.gitlabPages(z.looseObject({ id: z.string(), notes: z.array(z.unknown()) }),
      `projects/${project}/merge_requests/${number}/discussions?per_page=20&page=${page}`)
    const messages = discussions.flatMap(discussion => discussionMessages({ id: discussion.id, notes: validItems(NoteSchema, discussion.notes) }, ''))
    return { messages, ...discussions.length === 20 ? { next_resource: `gitlab/merge_requests/${number}/discussions/${page + 1}` } : {} }
  }
  const listed = await commands.gitlabPages(z.unknown(), `${path}/notes?sort=asc&order_by=created_at&per_page=20&page=${page}`)
  const tally = { skipped: 0 }
  const notes = validItems(NoteSchema, listed, tally).filter(note => note.system !== true)
  return { messages: notes.map(note => noteMessage(note, note.body ?? '', noteUrl('', note.id))),
    ...tally.skipped ? { skipped: tally.skipped } : {}, ...listed.length === 20 ? { next_resource: `gitlab/${kind}/${number}/notes/${page + 1}` } : {} }
}
/** Reads one page of an Issue or merge request conversation (with its description first on page 1). */
async function conversationPage(commands: Commands, issue: boolean, number: number, page: number) {
  const messages: ContextMessage[] = []
  const item = issue
    ? await commands.gitlabApi(ItemSchema, `projects/${commands.gitlabProject}/issues/${number}`)
    : await commands.gitlabApi(MergeRequestSchema, `projects/${commands.gitlabProject}/merge_requests/${number}`)
  if (page === 1) messages.push(noteMessage(item, `${item.title}\n\n${item.description ?? ''}`, item.web_url))
  const listed = await commands.gitlabPages(z.unknown(),
    `projects/${commands.gitlabProject}/${issue ? 'issues' : 'merge_requests'}/${number}/notes?sort=asc&order_by=created_at&per_page=100&page=${page}`)
  const tally = { skipped: 0 }
  const notes = validItems(NoteSchema, listed, tally).filter(note => note.system !== true)
  messages.push(...notes.map(note => noteMessage(note, note.body ?? '', noteUrl(item.web_url, note.id))))
  return { messages, next: listed.length === 100 ? String(page + 1) : undefined, ...tally.skipped ? { skipped: tally.skipped } : {}, url: item.web_url }
}
/**
 * Context reader for a GitLab Trigger: reads the discussion of an inline note, or the Issue or merge request conversation
 * by page otherwise (whose first page is its root and parent).
 */
export const gitlabThreadContext: ThreadContext<unknown> = {
  messageId: trigger => trigger.url ?? '',
  read: async (commands, trigger, part, cursor) => {
    // A default branch pipeline has no conversation; its Trigger is its context.
    if (typeof trigger.meta.ref === 'string' && trigger.meta.ci === true) {
      const message = { id: trigger.url ?? trigger.id, from: 'CI', at: trigger.at, text: trigger.text, bot: true as const }
      return { messages: [message], body: { status: 'pipeline', messages: [message] }, status: 'pipeline' }
    }
    // A note's meta.kind names how it arrives ('conversation', 'inline'); the Thread key names what it is on.
    const ref = threadRef(trigger.threads[0]?.id ?? '')
    const number = ref?.number ?? Number(trigger.meta.number)
    const issue = ref?.kind === 'issue'
    if (trigger.meta.kind === 'inline' && typeof trigger.meta.discussionId === 'string') {
      const discussion = await discussionOf(commands, number, Number(trigger.meta.noteId))
      const messages = discussion ? discussionMessages(discussion, '') : []
      const read = part === 'thread' ? messages : messages.slice(0, 1)
      return { messages: read, body: { status: 'discussion', messages: read }, status: 'discussion' }
    }
    const body = await conversationPage(commands, issue, number, Number(cursor ?? '1'))
    return { messages: body.messages, next: body.next, body }
  },
}
