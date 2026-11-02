/** Normalizes GitLab issues, merge requests, notes, discussion notes, and pipeline transitions into domain Triggers. */
import { z } from 'zod'
import { key, type ChannelRef, type Trigger } from '../core/index.ts'
import { escapeRegExp, sameName } from '../infra/text.ts'

export const SOURCE = 'gitlab'
/** Spaces an Issue and a merge request keep separate: both number their own objects from 1. */
export type Kind = 'issue' | 'mergeRequest'
/** How a Trigger reads the Thread it belongs to: an Issue, a merge request, or one discussion note inside it. */
export type NoteKind = 'issue' | 'mergeRequest' | 'conversation' | 'inline'
export interface NotificationRef { number: number; kind: Kind }
/** A Trigger names its Thread as `gitlab:issue:12` or `gitlab:mr:12`, so the two number spaces never meet. */
export const gitlabThread = (kind: Kind, number: number): string => `gitlab:${kind === 'issue' ? 'issue' : 'mr'}:${number}`
/** The `id` of a Trigger's `ThreadRef`; `threadKey` prepends the source, giving `gitlab:mr:12`. */
export const threadId = (kind: Kind, number: number): string => `${kind === 'issue' ? 'issue' : 'mr'}:${number}`
/** Reads the Issue or merge request number out of a Thread key or id, with the kind when the key names one. */
export function threadRef(thread: string): { kind?: Kind; number: number } | undefined {
  const match = /^(?:gitlab:)?(?:(issue|mr):)?(\d+)$/.exec(thread)
  if (!match) return undefined
  return { ...match[1] ? { kind: match[1] === 'mr' ? 'mergeRequest' as const : 'issue' as const } : {}, number: Number(match[2]) }
}
/** The web page of an Issue or merge request. */
export const gitlabPage = (url: string, project: string, number: number, kind: Kind = 'issue'): string =>
  `${url}/${project}/-/${kind === 'issue' ? 'issues' : 'merge_requests'}/${number}`
/** Reply address: the Issue or merge request conversation, or one discussion thread when `discussion` is set. */
export const gitlabChannel = (ref: { number: number; kind: Kind; discussion?: string; url?: string }): ChannelRef => ({
  source: SOURCE, thread: gitlabThread(ref.kind, ref.number),
  address: { number: String(ref.number), kind: ref.kind, ...ref.discussion ? { discussion: ref.discussion } : {}, ...ref.url ? { url: ref.url } : {} },
})
/** Parses a web URL of an Issue, merge request, or note inside one, in `project` on `host`; other URLs return undefined. */
export function gitlabAddress(url: string, host: string, project: string): { number: number; kind: Kind; note?: number } | undefined {
  if (!url) return undefined
  let parsed: URL
  try { parsed = new URL(url) } catch { return undefined }
  if (!sameName(parsed.hostname, host)) return undefined
  const path = decodeURIComponent(parsed.pathname)
  const escaped = escapeRegExp(project)
  const match = new RegExp(`^/${escaped}/-/(issues|merge_requests)/(\\d+)/?(?:#note_(\\d+)|#[\w-]*)?$`).exec(path)
  if (!match) return undefined
  return { number: Number(match[2]), kind: match[1] === 'issues' ? 'issue' : 'mergeRequest', ...match[3] ? { note: Number(match[3]) } : {} }
}
/** GitLab returns a deleted account as `null` and shows it as `ghost`. */
export const UserSchema = z.looseObject({ username: z.string(), name: z.string().nullish(), bot: z.boolean().nullish(), state: z.string().nullish() })
  .nullable().transform(user => user ?? { username: 'ghost' })
export type GitlabUser = z.infer<typeof UserSchema>
/** A note on an Issue or merge request; `system` marks an activity line GitLab wrote itself, such as a label change. */
export const NoteSchema = z.looseObject({
  id: z.number(), body: z.string().nullish(), system: z.boolean().nullish(), author: UserSchema,
  created_at: z.string().nullish(), updated_at: z.string().nullish(), type: z.string().nullish(),
  position: z.looseObject({ new_path: z.string().nullish(), new_line: z.number().nullish(), old_path: z.string().nullish(),
    old_line: z.number().nullish(), head_sha: z.string().nullish() }).nullish(),
})
export type GitlabNote = z.infer<typeof NoteSchema>
/** A discussion: notes with one discussion id, and `position` set on a note written on a line of the diff. */
export const DiscussionSchema = z.looseObject({ id: z.string(), individual_note: z.boolean().nullish(), notes: z.array(z.unknown()) })
/** An Issue or merge request as its own endpoint returns it. */
export const ItemSchema = NoteSchema.extend({
  iid: z.number(), title: z.string(), state: z.string(), created_at: z.string(), web_url: z.string(),
  labels: z.array(z.union([z.string(), z.looseObject({ name: z.string() })])).nullish(),
  description: z.string().nullish(),
})
export type GitlabItem = z.infer<typeof ItemSchema>
export const MergeRequestSchema = ItemSchema.extend({
  merged_at: z.string().nullish(), closed_at: z.string().nullish(), merged: z.boolean().nullish(),
  source_branch: z.string(), target_branch: z.string(), source_project_id: z.number().nullish(), target_project_id: z.number().nullish(),
  merge_status: z.string().nullish(), has_conflicts: z.boolean().nullish(),
  pipeline: z.looseObject({ id: z.number().nullish(), status: z.string(), sha: z.string().nullish() }).nullish(),
  head_pipeline: z.looseObject({ id: z.number().nullish(), status: z.string(), sha: z.string().nullish() }).nullish(),
  sha: z.string().nullish(), draft: z.boolean().nullish(), work_in_progress: z.boolean().nullish(),
})
export type GitlabMergeRequest = z.infer<typeof MergeRequestSchema>
export interface NoteRef { number: number; kind: Kind; url?: string; itemAuthor?: string; discussion?: string }
type Opened = Pick<GitlabItem, 'iid' | 'title' | 'description' | 'author' | 'created_at' | 'web_url'>
/**
 * True when GitLab reports the account as a regular user.
 * Project bot accounts carry `bot`; the prompts identify which accounts are automated.
 */
export const isHumanLogin = (user: { username: string; bot?: boolean | null }): boolean => user.bot !== true && user.username !== 'ghost'
export const mentions = (text: string, login: string): boolean =>
  new RegExp(`(?:^|[^a-zA-Z0-9_@])@${escapeRegExp(login)}(?![a-zA-Z0-9_-])`, 'i').test(text)
const author = (user: { username: string; bot?: boolean | null }, agent: string) =>
  ({ actor: { source: SOURCE, id: user.username }, human: isHumanLogin(user) && !sameName(user.username, agent) })
/** Formats a note written on a line of the diff: its path and line, then the body. */
export function notePlace(note: GitlabNote): string {
  const place = note.position
  const path = place?.new_path ?? place?.old_path
  const line = place?.new_line ?? place?.old_line
  return path ? `${path}${line != null ? `:${line}` : ''}` : ''
}
const noteText = (note: GitlabNote, kind: NoteKind): string => [kind === 'inline' ? notePlace(note) : '', note.body ?? ''].filter(Boolean).join('\n\n')
/**
 * Builds the trigger for a note or a discussion note; `system` notes GitLab wrote itself never reach a Thread, and a
 * note without a body is not a message.
 */
export function noteTrigger(note: GitlabNote, ref: NoteRef, kind: Exclude<NoteKind, 'issue' | 'mergeRequest'>, agent: string): Trigger | undefined {
  if (note.system === true) return undefined
  const text = noteText(note, kind)
  if (!text.trim()) return undefined
  const at = note.updated_at ?? note.created_at ?? new Date().toISOString()
  const url = ref.url ? `${ref.url}#note_${note.id}` : undefined
  return { id: key('gitlab-note', kind, String(ref.number), String(note.id), note.updated_at ?? ''), source: SOURCE,
    threads: [{ source: SOURCE, id: threadId(ref.kind, ref.number) }], ...author(note.author, agent), at, text,
    ...mentions(note.body ?? '', agent) ? { addressed: 'mention' as const } : {},
    channel: gitlabChannel({ number: ref.number, kind: ref.kind, ...ref.discussion ? { discussion: ref.discussion } : {}, ...url ? { url } : {} }),
    ...url ? { url } : {},
    meta: { number: ref.number, kind, isMr: ref.kind === 'mergeRequest', noteId: note.id, ...ref.discussion ? { discussionId: ref.discussion } : {},
      ...ref.itemAuthor ? { itemAuthor: ref.itemAuthor } : {},
      ...note.position?.new_path ? { path: note.position.new_path, line: note.position.new_line ?? note.position.old_line ?? null } : {} } }
}
/**
 * Builds the trigger for a newly opened Issue's title and description.
 * The ID depends only on the Issue, so a description read twice is admitted once.
 */
export function issueTrigger(issue: Opened, agent: string): Trigger {
  const body = issue.description ?? ''
  return { id: key('gitlab-issue', String(issue.iid)), source: SOURCE, threads: [{ source: SOURCE, id: threadId('issue', issue.iid) }],
    ...author(issue.author, agent), at: issue.created_at, text: `${issue.title}\n\n${body}`,
    ...mentions(body, agent) ? { addressed: 'mention' as const } : {},
    channel: gitlabChannel({ number: issue.iid, kind: 'issue', url: issue.web_url }), url: issue.web_url,
    meta: { number: issue.iid, kind: 'issue', isMr: false } }
}
/** Builds the trigger for a newly opened merge request's title and description. */
export function mergeRequestTrigger(mr: Opened & { source_branch?: string }, agent: string): Trigger {
  const body = mr.description ?? ''
  return { id: key('gitlab-mr', String(mr.iid)), source: SOURCE, threads: [{ source: SOURCE, id: threadId('mergeRequest', mr.iid) }],
    ...author(mr.author, agent), at: mr.created_at, text: `${mr.title}\n\n${body}`,
    ...mentions(body, agent) ? { addressed: 'mention' as const } : {},
    channel: gitlabChannel({ number: mr.iid, kind: 'mergeRequest', url: mr.web_url }), url: mr.web_url,
    meta: { number: mr.iid, kind: 'mergeRequest', isMr: true, ...mr.source_branch ? { sourceBranch: mr.source_branch } : {} } }
}
/** Builds a trigger for a default-branch pipeline transition; a pipeline has no person to reply to, so it has no `channel`. */
export function pipelineTrigger(ref: string, sha: string, revision: number, summary: string, url: string): Trigger {
  return { id: key('gitlab-pipeline', ref, sha, String(revision)), source: SOURCE, threads: [{ source: SOURCE, id: `ci:${ref}` }],
    actor: { source: SOURCE, id: '' }, human: false, at: new Date().toISOString(), text: summary, url,
    meta: { ci: true, ref, sha, revision } }
}
/** Builds a trigger for a merge request's pipeline transition. */
export function mergeRequestPipelineTrigger(mr: { number: number; url: string; author?: string }, sha: string, revision: number, summary: string): Trigger {
  return { id: key('gitlab-mr-pipeline', String(mr.number), sha, String(revision)), source: SOURCE,
    threads: [{ source: SOURCE, id: threadId('mergeRequest', mr.number) }], actor: { source: SOURCE, id: '' }, human: false,
    at: new Date().toISOString(), text: summary, channel: gitlabChannel({ number: mr.number, kind: 'mergeRequest', url: mr.url }), url: mr.url,
    meta: { number: mr.number, kind: 'mergeRequest', isMr: true, ...mr.author ? { itemAuthor: mr.author } : {}, ci: true, revision } }
}
