import { describe, expect, it } from 'vitest'
import { threadKey, type ThreadFact, type Ticket, type Trigger } from '../src/core/index.ts'
import type { Deployment } from '../src/deployment.ts'
import { Commands } from '../src/infra/commands.ts'
import { claimMergeRequest, mergeRequestEndNotices, mergeRequestOf, mergeRequestsOf,
  observeMergeRequest } from '../src/sources/gitlab-merge-request.ts'
import { type GitlabMergeRequest } from '../src/sources/gitlab-trigger.ts'
import type { SourceContext } from '../src/sources/host.ts'
import { testDeployment } from './fixtures/deployment.ts'

const deployment: Deployment = {
  ...testDeployment(),
  gitlab: { cli: '/bin/false', login: 'agent-bot', id: 7, host: 'gitlab.local', url: 'http://gitlab.local', project: 'acme/widgets',
    projectId: 42, noreply: '7-agent-bot@users.noreply.gitlab.local' },
}
const commands = new Commands(() => deployment, {}, new AbortController().signal)

/** A merge request payload as GitLab 13.1 returns it, with the fields these tests read. */
const mergeRequest = (overrides: Partial<GitlabMergeRequest> & { iid: number }): GitlabMergeRequest => ({
  id: overrides.iid, title: 'Add the margin', state: 'opened', created_at: '2026-09-09T00:00:00Z',
  web_url: `http://gitlab.local/acme/widgets/-/merge_requests/${overrides.iid}`,
  author: { username: 'carol' }, source_branch: 'feature/margin', target_branch: 'main', source_project_id: 42, target_project_id: 42,
  ...overrides,
})

/** An open ticket whose origin is the trigger `source-<id>`, as the Engine stores one. */
const openTicket = (id: string, overrides: Partial<Ticket> = {}): Ticket => ({
  id, title: id, decisionId: `d-${id}`,
  mandate: { strength: 'explicit', policyVersion: '', basis: { via: 'listed' }, actor: { source: 'gitlab', id: 'carol' }, scope: '' },
  channels: [], assignments: [], inputs: [], undelivered: [], createdAt: '', updatedAt: '',
  origin: { triggerId: `source-${id}`, triggerIds: [] }, ...overrides,
})
/** The Trigger an issue or merge request conversation starts, naming its Thread as the GitLab Source does. */
const triggerOf = (id: string, number: number): Trigger => ({
  id, source: 'gitlab', threads: [{ source: 'gitlab', id: `mr:${number}` }], actor: { source: 'gitlab', id: 'carol' },
  human: true, at: '2026-09-09T00:00:00Z', text: 'Add the margin', meta: { number, isMr: true, kind: 'mergeRequest' },
})
/** An in-memory SourceContext with the ticket, thread, and trigger state these functions read and write. */
function context(tickets: Ticket[], triggers: Record<string, Trigger> = {}) {
  const described = new Map<string, Record<string, ThreadFact | null>>()
  const patched = new Map<string, Record<string, unknown>>()
  const closed: { thread: string; outcome: 'merged' | 'closed'; at: string }[] = []
  const value: SourceContext = {
    deployment, commands, ready: Promise.resolve(), configured: () => true, receive: () => 'stored',
    config: <C extends Record<string, unknown>>() => undefined as C | undefined,
    atomic: work => work(),
    state: { get: () => undefined, set: () => {}, keys: () => [] },
    threads: {
      get: () => undefined, subscribed: () => [],
      describe: (key, description) => { described.set(key, description.facts ?? {}) },
      patch: (key, meta) => { patched.set(key, { ...patched.get(key), ...meta }) },
    },
    tickets: {
      get: id => tickets.find(ticket => ticket.id === id),
      open: () => tickets.filter(ticket => !ticket.ended),
      bindThread: (id, ref, own) => {
        const ticket = tickets.find(item => item.id === id)!
        const thread = threadKey(ref)
        const follow = ticket.follows?.find(item => item.thread === thread)
        if (follow) { follow.own ||= own; delete follow.closed } else ticket.follows = [...ticket.follows ?? [], { thread, own }]
      },
      // Mirrors the core: a close marks the follow, and later closes find nothing to mark.
      threadClosed: (ref, outcome, at) => {
        const thread = threadKey(ref)
        for (const ticket of tickets.filter(item => !item.ended)) {
          const follow = ticket.follows?.find(item => item.thread === thread && !item.closed)
          if (follow) { follow.closed = { at, outcome }; closed.push({ thread, outcome, at }) }
        }
      },
    },
    triggers: { get: id => triggers[id], latest: () => undefined },
    notify: () => {}, report: () => {},
  }
  return { ctx: value, described, patched, closed }
}

describe('claimMergeRequest', () => {
  it('rejects a merge request that is neither the source merge request nor an agent one', () => {
    const ticket = openTicket('t1')
    const { ctx, patched } = context([ticket], { 'source-t1': triggerOf('source-t1', 99) })
    const message = claimMergeRequest(ctx, 't1', mergeRequest({ iid: 12 }))
    expect(message).toBe('Merge request does not belong to this ticket: use the source merge request or a merge request by agent-bot '
      + 'from a branch whose last path segment is DSH_SUPERAGENT_NAME; omit mr_iid when no merge request exists')
    expect(ticket.follows).toBeUndefined()
    expect(patched.size).toBe(0)
  })
  it('binds the source merge request of the ticket', () => {
    const ticket = openTicket('t1')
    const { ctx, patched } = context([ticket], { 'source-t1': triggerOf('source-t1', 12) })
    expect(claimMergeRequest(ctx, 't1', mergeRequest({ iid: 12 }))).toBeUndefined()
    // The trigger opened the merge request, so the ticket did not open it itself.
    expect(ticket.follows).toEqual([{ thread: 'gitlab:mr:12', own: false }])
    expect(patched.get('gitlab:mr:12')).toEqual({ number: 12, isMr: true, itemAuthor: 'carol',
      url: 'http://gitlab.local/acme/widgets/-/merge_requests/12' })
  })
  it('refuses a merge request another open ticket already owns', () => {
    const other = openTicket('t2', { follows: [{ thread: 'gitlab:mr:12', own: true }] })
    const ticket = openTicket('t1')
    const { ctx } = context([other, ticket], { 'source-t1': triggerOf('source-t1', 12) })
    expect(claimMergeRequest(ctx, 't1', mergeRequest({ iid: 12 }))).toBe('Merge request already belongs to another active ticket')
  })
})

describe('mergeRequestsOf', () => {
  it('reads merge request numbers and separates closed from open ones', () => {
    const ticket = openTicket('t1', { follows: [
      { thread: 'gitlab:mr:12', own: true, closed: { at: '2026-09-09T01:00:00.000Z', outcome: 'merged' } },
      { thread: 'gitlab:mr:13', own: false },
      { thread: 'gitlab:issue:5', own: false },
    ] })
    expect(mergeRequestsOf(ticket)).toEqual([12, 13])
    expect(mergeRequestsOf(ticket, true)).toEqual([13])
    expect(mergeRequestOf(ticket)).toBe(13)
    expect(mergeRequestsOf(openTicket('t9'))).toEqual([])
  })
})

describe('observeMergeRequest', () => {
  it('reports a merged merge request once to the tickets that follow it', async () => {
    const ticket = openTicket('t1', { follows: [{ thread: 'gitlab:mr:12', own: true }] })
    const { ctx, closed } = context([ticket])
    const merged = mergeRequest({ iid: 12, state: 'merged', merged: true, merged_at: '2026-09-09T01:00:00Z' })
    expect(await observeMergeRequest(ctx, merged)).toBe(true)
    expect(closed).toEqual([{ thread: 'gitlab:mr:12', outcome: 'merged', at: '2026-09-09T01:00:00Z' }])
    // A second poll finds the follow already closed and reports nothing again.
    expect(await observeMergeRequest(ctx, merged)).toBe(true)
    expect(closed).toHaveLength(1)
  })
  it('binds the single open ticket on the branch and describes the pipeline', async () => {
    const ticket = openTicket('t1', { execution: { name: 'margin', directory: '/w/margin', assignment: '' } })
    const { ctx, described } = context([ticket])
    const opened = mergeRequest({ iid: 12, state: 'opened', author: { username: 'agent-bot' }, source_branch: 'agent/margin',
      pipeline: { id: 1, status: 'running', sha: 'abc' } })
    expect(await observeMergeRequest(ctx, opened)).toBe(false)
    expect(ticket.follows).toEqual([{ thread: 'gitlab:mr:12', own: true }])
    expect(described.get('gitlab:mr:12')).toEqual({ pipeline: { label: { zh: '流水线', en: 'Pipeline' }, value: 'running' } })
  })
  it('reports a closed merge request as closed', async () => {
    const ticket = openTicket('t1', { follows: [{ thread: 'gitlab:mr:12', own: true }] })
    const { ctx, closed } = context([ticket])
    const closedMergeRequest = mergeRequest({ iid: 12, state: 'closed', merged: false, closed_at: '2026-09-09T02:00:00Z' })
    expect(await observeMergeRequest(ctx, closedMergeRequest)).toBe(true)
    expect(closed).toEqual([{ thread: 'gitlab:mr:12', outcome: 'closed', at: '2026-09-09T02:00:00Z' }])
  })
})

describe('mergeRequestEndNotices', () => {
  it('notices a merged merge request in Chinese to non-GitLab channels only', () => {
    const ticket = openTicket('t1', {
      ended: { at: '2026-09-09T01:00:00.000Z', by: 'executor', outcome: 'merged' },
      follows: [{ thread: 'gitlab:mr:12', own: true, closed: { at: '2026-09-09T01:00:00.000Z', outcome: 'merged' } }],
      channels: [
        { source: 'gitlab', thread: 'gitlab:mr:12', address: { number: '12', kind: 'mergeRequest' } },
        { source: 'feishu', thread: 'oc_team', address: { chat: 'oc_team' } },
      ],
    })
    const notices = mergeRequestEndNotices(ticket, '修一下边距', deployment)
    expect(notices).toHaveLength(1)
    expect(notices[0]!.channel.source).toBe('feishu')
    expect(notices[0]!.text).toBe('[MR !12](http://gitlab.local/acme/widgets/-/merge_requests/12) 已合并。')
  })
  it('notices a closed merge request in English', () => {
    const ticket = openTicket('t1', {
      ended: { at: '2026-09-09T02:00:00.000Z', by: 'executor', outcome: 'closed' },
      follows: [{ thread: 'gitlab:mr:12', own: true, closed: { at: '2026-09-09T02:00:00.000Z', outcome: 'closed' } }],
      channels: [{ source: 'feishu', thread: 'oc_team', address: { chat: 'oc_team' } }],
    })
    expect(mergeRequestEndNotices(ticket, 'Fix the margin', deployment)[0]!.text)
      .toBe('[MR !12](http://gitlab.local/acme/widgets/-/merge_requests/12) was closed without merging.')
  })
})
