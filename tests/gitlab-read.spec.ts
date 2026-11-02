import { afterEach, expect, it, vi } from 'vitest'
import { Commands } from '../src/infra/commands.ts'
import { testDeployment } from './fixtures/deployment.ts'
import { gitlabThreadContext, mergeable, readGitlab } from '../src/sources/gitlab-read.ts'
import { MergeRequestSchema, noteTrigger, type GitlabMergeRequest } from '../src/sources/gitlab-trigger.ts'
import type { Deployment } from '../src/deployment.ts'

const deployment: Deployment = { ...testDeployment(), gitlab: { cli: '/bin/false', login: 'agent-bot', id: 7, host: 'gitlab.local',
  url: 'http://gitlab.local', project: 'acme/widgets', projectId: 42, noreply: '7-agent-bot@users.noreply.gitlab.local' } }
const commands = new Commands(() => deployment, {}, new AbortController().signal)
afterEach(() => vi.restoreAllMocks())

/** A note as GitLab returns it, written by carol unless `fields` says otherwise. */
const note = (id: number, body: string, fields: Record<string, unknown> = {}) => ({ id, body, author: { username: 'carol' },
  created_at: `2026-09-09T00:00:0${id % 10}Z`, ...fields })
/** An Issue as GitLab returns it. */
const issue = (iid: number, fields: Record<string, unknown> = {}) => ({ id: 1000 + iid, iid, title: 'Login fails', description: 'Details',
  state: 'opened', author: { username: 'alice' }, created_at: '2026-09-09T00:00:00Z',
  web_url: `http://gitlab.local/acme/widgets/-/issues/${iid}`, ...fields })
/** A merge request as GitLab 13.1 returns it. */
const mergeRequest = (iid: number, fields: Record<string, unknown> = {}) => ({ ...issue(iid, { title: 'Fix the margin',
  web_url: `http://gitlab.local/acme/widgets/-/merge_requests/${iid}` }), source_branch: 'fix', target_branch: 'main', ...fields })
/** Answers page reads with `routes` by API path, ignoring the query string. */
function pages(routes: Record<string, unknown[]>): void {
  vi.spyOn(commands, 'gitlabPages').mockImplementation(async (_item, path) => routes[path.split('?')[0]!] ?? [])
}
/** Answers single-object reads with `value`. */
function item(value: unknown): void {
  vi.spyOn(commands, 'gitlabApi').mockResolvedValue(value as never)
}

it('reads a bounded note page and exposes the next page reference', async () => {
  const listed = vi.spyOn(commands, 'gitlabPages').mockResolvedValue(Array.from({ length: 20 }, (_, index) => note(index + 1, `comment ${index + 1}`)))
  expect(await readGitlab(commands, 'gitlab/issues/12/notes/2')).toMatchObject({ next_resource: 'gitlab/issues/12/notes/3' })
  expect(listed).toHaveBeenCalledWith(expect.anything(), 'projects/42/issues/12/notes?sort=asc&order_by=created_at&per_page=20&page=2')
})

it('reads notes as messages, leaves out system activity, and counts records it cannot read', async () => {
  pages({ 'projects/42/merge_requests/9/notes': [note(1, 'Looks good'), note(2, 'added 1 commit', { system: true }),
    { body: 'no id' }, note(3, 'Thanks', { author: { username: 'ghost' } })] })
  expect(await readGitlab(commands, 'gitlab/merge_requests/9/notes/1')).toEqual({
    messages: [{ id: '#note_1', from: 'carol', at: '2026-09-09T00:00:01Z', text: 'Looks good' },
      { id: '#note_3', from: 'ghost', at: '2026-09-09T00:00:03Z', text: 'Thanks', bot: true }], skipped: 1 })
})

it('rejects unsupported or escaping paths without making a request', async () => {
  const listed = vi.spyOn(commands, 'gitlabPages')
  const single = vi.spyOn(commands, 'gitlabApi')
  for (const resource of ['gitlab/../outside', 'gitlab/issues/1/discussions', 'gitlab/issues/1/pipelines',
    'gitlab/merge_requests/1/pipelines/2', 'gitlab/merge_requests/0/notes/1', 'gitlab/issues/1?repo=other', 'github/issues/1']) {
    await expect(readGitlab(commands, resource)).rejects.toThrow()
  }
  expect(listed).not.toHaveBeenCalled()
  expect(single).not.toHaveBeenCalled()
})

it('names the discussion a thread read needs, and reports an id no discussion has', async () => {
  const listed = vi.spyOn(commands, 'gitlabPages')
  await expect(readGitlab(commands, 'gitlab/merge_requests/9/thread')).rejects.toThrow('Name the discussion by its id')
  expect(listed).not.toHaveBeenCalled()
  listed.mockResolvedValue([])
  await expect(readGitlab(commands, 'gitlab/merge_requests/9/thread/abc123')).rejects.toThrow('No discussion of this merge request has that id')
  expect(listed).toHaveBeenCalledTimes(2)
})

it('reads a merge request\'s pipelines with the statuses of its newest commit', async () => {
  pages({ 'projects/42/merge_requests/9/pipelines': [{ id: 7, status: 'failed', sha: 'deadbee' }, { id: 9, status: 'running', sha: 'feedfac' }],
    'projects/42/repository/commits/feedfac/statuses': [{ status: 'failed', name: 'lint' }, { status: 'success', name: 'test' }] })
  expect(await readGitlab(commands, 'gitlab/merge_requests/9/pipelines')).toEqual({ head: 'feedfac',
    pipelines: [{ id: 7, status: 'failed', sha: 'deadbee' }, { id: 9, status: 'running', sha: 'feedfac' }],
    statuses: [{ status: 'failed', name: 'lint' }, { status: 'success', name: 'test' }] })
})

it('reads a commit\'s pipelines and statuses by its abbreviated SHA', async () => {
  pages({ 'projects/42/pipelines': [{ id: 4, status: 'failed', sha: 'abcdef1' }],
    'projects/42/repository/commits/abcdef1/statuses': [{ status: 'failed', name: 'e2e' }] })
  expect(await readGitlab(commands, 'gitlab/commits/abcdef1/pipelines')).toEqual({ head: 'abcdef1',
    pipelines: [{ id: 4, status: 'failed', sha: 'abcdef1' }], statuses: [{ status: 'failed', name: 'e2e' }] })
})

it('reads one discussion of a merge request as a root and its replies, the root placed on the diff', async () => {
  pages({ 'projects/42/merge_requests/9/discussions': [{ id: 'abc123', notes: [
    note(2, 'Done', { created_at: '2026-09-09T00:00:02Z' }),
    note(1, 'Use the theme token', { created_at: '2026-09-09T00:00:01Z', position: { new_path: 'src/render.ts', new_line: 43 } })] }] })
  expect(await readGitlab(commands, 'gitlab/merge_requests/9/thread/1')).toEqual({ messages: [
    { id: '#note_1', from: 'carol', at: '2026-09-09T00:00:01Z', text: 'src/render.ts:43\n\nUse the theme token',
      url: '#note_1', path: 'src/render.ts', line: 43 },
    { id: '#note_2', from: 'carol', at: '2026-09-09T00:00:02Z', text: 'Done', url: '#note_2', reply_to: '#note_1' }] })
})

it('reads a page of discussions and exposes the next page reference', async () => {
  pages({ 'projects/42/merge_requests/9/discussions': Array.from({ length: 20 }, (_, index) => ({ id: `d${index}`, notes: [note(index + 1, 'x')] })) })
  const page = await readGitlab(commands, 'gitlab/merge_requests/9/discussions/2') as { messages: unknown[]; next_resource?: string }
  expect(page.messages).toHaveLength(20)
  expect(page.next_resource).toBe('gitlab/merge_requests/9/discussions/3')
})

/** A merge request GitLab reports as open, conflict-free, mergeable, with a passed pipeline. */
const mergeableMergeRequest = (fields: Partial<GitlabMergeRequest> = {}): GitlabMergeRequest =>
  MergeRequestSchema.parse({ ...mergeRequest(9), merge_status: 'can_be_merged', has_conflicts: false,
    head_pipeline: { id: 3, status: 'success' }, ...fields })
it('decides whether a merge request may merge from GitLab 13.1 fields', () => {
  expect(mergeable(mergeableMergeRequest())).toEqual({ ok: true, reason: 'it is open, conflict-free, and its pipeline passed' })
  expect(mergeable(mergeableMergeRequest({ state: 'merged', merged: true }))).toEqual({ ok: false, reason: 'the merge request is merged' })
  expect(mergeable(mergeableMergeRequest({ has_conflicts: true }))).toEqual({ ok: false, reason: 'it has conflicts' })
  expect(mergeable(mergeableMergeRequest({ merge_status: 'cannot_be_merged' }))).toEqual({ ok: false, reason: 'GitLab reports cannot_be_merged' })
  expect(mergeable(mergeableMergeRequest({ head_pipeline: { status: 'running' } }))).toEqual({ ok: false, reason: 'its pipeline is running' })
  // The head pipeline wins over the merge request's own pipeline; a skipped pipeline still allows the merge.
  expect(mergeable(mergeableMergeRequest({ pipeline: { status: 'failed' }, head_pipeline: { status: 'skipped' } }))).toMatchObject({ ok: true })
  expect(mergeable(mergeableMergeRequest({ head_pipeline: null, pipeline: { status: 'failed' } }))).toEqual({ ok: false, reason: 'its pipeline is failed' })
})

it('gives a conversation assessment the description and the notes of a merge request', async () => {
  const url = 'http://gitlab.local/acme/widgets/-/merge_requests/9'
  item(mergeRequest(9))
  pages({ 'projects/42/merge_requests/9/notes': [note(1, 'Looks good'), note(2, 'added a label', { system: true })] })
  const trigger = noteTrigger(note(1, 'Looks good'), { number: 9, kind: 'mergeRequest', url, itemAuthor: 'alice' }, 'conversation', 'agent-bot')!
  expect(gitlabThreadContext.messageId(trigger)).toBe(`${url}#note_1`)
  const part = await gitlabThreadContext.read(commands, trigger, 'thread', undefined, {})
  expect(part.status).toBeUndefined()
  expect(part.body).toMatchObject({ url })
  expect(part.messages).toEqual([
    { id: url, from: 'alice', at: '2026-09-09T00:00:00Z', text: 'Fix the margin\n\nDetails' },
    { id: `${url}#note_1`, from: 'carol', at: '2026-09-09T00:00:01Z', text: 'Looks good' }])
})

it('gives an inline note assessment its discussion, and only the root for the replied-to part', async () => {
  pages({ 'projects/42/merge_requests/9/discussions': [{ id: 'abc123', notes: [
    note(1, 'Use the theme token', { position: { new_path: 'src/render.ts', new_line: 43 } }), note(2, 'Done')] }] })
  const trigger = noteTrigger(note(2, 'Done'), { number: 9, kind: 'mergeRequest', url: 'http://gitlab.local/acme/widgets/-/merge_requests/9',
    discussion: 'abc123' }, 'inline', 'agent-bot')!
  const thread = await gitlabThreadContext.read(commands, trigger, 'thread', undefined, {})
  expect(thread).toMatchObject({ status: 'discussion' })
  expect(thread.messages.map(message => message.id)).toEqual(['#note_1', '#note_2'])
  expect(thread.messages[0]).toMatchObject({ path: 'src/render.ts', line: 43 })
  const parent = await gitlabThreadContext.read(commands, trigger, 'parent', undefined, {})
  expect(parent).toMatchObject({ status: 'discussion' })
  expect(parent.messages.map(message => message.id)).toEqual(['#note_1'])
})

it('pages a conversation by its cursor and stops once a page is short', async () => {
  const url = 'http://gitlab.local/acme/widgets/-/merge_requests/9'
  item(mergeRequest(9))
  const listed = vi.spyOn(commands, 'gitlabPages').mockResolvedValue(Array.from({ length: 100 }, (_, index) => note(index + 1, 'note')))
  const trigger = noteTrigger(note(1, 'hello'), { number: 9, kind: 'mergeRequest', url, itemAuthor: 'alice' }, 'conversation', 'agent-bot')!
  expect((await gitlabThreadContext.read(commands, trigger, 'thread', undefined, {})).next).toBe('2')
  expect(listed).toHaveBeenCalledWith(expect.anything(),
    'projects/42/merge_requests/9/notes?sort=asc&order_by=created_at&per_page=100&page=1')
  listed.mockResolvedValue([])
  expect((await gitlabThreadContext.read(commands, trigger, 'thread', '2', {})).next).toBeUndefined()
})

it('reads a merge request as its branches, state and description', async () => {
  item(mergeRequest(9, { draft: true }))
  expect(await readGitlab(commands, 'gitlab/merge_requests/9')).toMatchObject({ number: 9, title: 'Fix the margin', state: 'opened',
    source_branch: 'fix', target_branch: 'main', draft: true, from: 'alice', text: 'Details' })
})

it('reads an Issue as its author, time, title, state and description', async () => {
  item(issue(12))
  expect(await readGitlab(commands, 'gitlab/issues/12')).toEqual({ number: 12, title: 'Login fails', state: 'opened',
    id: 'http://gitlab.local/acme/widgets/-/issues/12', from: 'alice', at: '2026-09-09T00:00:00Z', text: 'Details',
    url: 'http://gitlab.local/acme/widgets/-/issues/12' })
})
