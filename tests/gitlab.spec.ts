import { describe, expect, it, vi } from 'vitest'
import { Engine, type Assessor, type Executor, type Ticket, type Trigger } from '../src/core/index.ts'
import { Store } from '../src/app/store.ts'
import { sourceContextOf, type SourceContextDeps } from '../src/app/source-context.ts'
import { Commands } from '../src/infra/commands.ts'
import { HealthBoard } from '../src/infra/health.ts'
import { SettingsSchema, settingsPolicy } from '../src/policy.ts'
import { SourceRegistry } from '../src/sources/registry.ts'
import { apply as applyGitlab, gitlabKind } from '../src/sources/gitlab.ts'
import { ItemSchema, MergeRequestSchema, gitlabThread, issueTrigger, mergeRequestTrigger, threadId } from '../src/sources/gitlab-trigger.ts'
import { testDeployment } from './fixtures/deployment.ts'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const account = { cli: '/bin/false', login: 'agent-bot', id: 7, host: 'gitlab.local', url: 'http://gitlab.local',
  project: 'acme/widgets', projectId: 42, noreply: '7-agent-bot@users.noreply.gitlab.local' }
const deployment = testDeployment({ gitlab: account })
const SINCE = '2026-09-08T00:00:00.000Z'

function host(overrides: Partial<SourceContextDeps> = {}, reused?: Store) {
  const store = reused ?? new Store(join(mkdtempSync(join(tmpdir(), 'gitlab-')), 'db.sqlite'))
  const settings = SettingsSchema.parse({ policy: { sources: { gitlab: { allowed: [{ id: 'alice' }, { id: 'carol' }] } } },
    eval: { mode: 'auto' }, sources: { gitlab: { enabled: true, config: {} } } })
  store.saveSettings(settings)
  const board = new HealthBoard()
  const sources = new SourceRegistry(() => store.settings(), board)
  sources.register(gitlabKind)
  const assessor: Assessor = { request: vi.fn(async () => {}) }
  const executor: Executor = { start: vi.fn(async () => {}), deliver: vi.fn(async () => {}), stop: vi.fn(async () => {}) }
  const outbox = { send: () => {}, status: () => undefined, withdraw: () => {} }
  const engine = new Engine({ repo: store, scope: sources, policy: () => settingsPolicy(store.settings(), sources), assessor, executor, outbox })
  const commands = new Commands(() => deployment, {}, new AbortController().signal)
  const receive = vi.fn(async (trigger: Trigger) => { const result = engine.receive(trigger); engine.evaluateDue(); return result })
  const parts: SourceContextDeps = { store, engine, outbox: { send: message => { store.receipts.add(message) } }, commands,
    sources: overrides.sources ?? sources, deployment, ready: Promise.resolve(), configured: () => true, receive, ...overrides }
  const value = { ...parts, context: (kind: { kind: string; health: readonly string[] }) => sourceContextOf(parts, kind) }
  const context = sourceContextOf(parts, gitlabKind)
  const health = overrides.sources ? healthOf.get(overrides.sources)!.all : board.all
  return { ...value, ...context, health, store, engine, commands: parts.commands, receive, executor }
}
const healthOf = new WeakMap<SourceRegistry, HealthBoard>()
const openTicket = (id: string): Ticket => ({ id, title: id, decisionId: `d-${id}`, mandate: { strength: 'explicit', policyVersion: '',
  basis: { via: 'listed' }, actor: { source: 'gitlab', id: 'alice' }, scope: '' },
  channels: [], assignments: [], inputs: [], undelivered: [], createdAt: '', updatedAt: '', origin: { triggerId: `source-${id}`, triggerIds: [] } })
const seedThread = (store: Store, kind: 'issue' | 'mergeRequest', number: number) => store.threads.save({ key: gitlabThread(kind, number),
  ref: { source: 'gitlab', id: threadId(kind, number) }, createdAt: '', subscriptions: [], correlated: [], pending: [], meta: { number, kind } })
const issue = (iid: number) => ItemSchema.parse({ id: 1000 + iid, iid, title: 'Login fails', description: 'Details', state: 'opened',
  created_at: '2026-09-09T00:00:00Z', web_url: `http://gitlab.local/acme/widgets/-/issues/${iid}`, author: { username: 'alice' } })
const mergeRequest = (iid: number, fields: Record<string, unknown> = {}) => MergeRequestSchema.parse({ id: 2000 + iid, iid,
  title: 'Fix the margin', description: 'Details', state: 'opened', created_at: '2026-09-09T00:00:00Z',
  web_url: `http://gitlab.local/acme/widgets/-/merge_requests/${iid}`, author: { username: 'carol' },
  source_branch: 'fix', target_branch: 'main', ...fields })
const note = (id: number, body: string, fields: Record<string, unknown> = {}) => ({ id, body, author: { username: 'alice' },
  created_at: '2026-09-09T01:00:00Z', ...fields })
/** Stubs `glab api` calls by API path (query string dropped) and returns the requested paths in order. */
function gitlab(h: ReturnType<typeof host>, routes: Record<string, unknown>): string[] {
  const reads: string[] = []
  vi.spyOn(h.commands, 'run').mockImplementation(async (_program, args) => {
    const path = args[3] ?? ''
    reads.push(path)
    const route = routes[path.split('?')[0]!]
    const value: unknown = typeof route === 'function' ? (route as () => unknown)() : route
    if (value instanceof Error) throw value
    if (value === undefined) throw new Error(`unexpected GitLab read: ${path}`)
    return Array.isArray(value) ? value.map(entry => JSON.stringify(entry)).join('\n') : JSON.stringify(value)
  })
  return reads
}
/** Applies the plugin to a fresh registry so the polling loop runs as it would in the Runtime. */
function start(options: { routes?: Record<string, unknown>; config?: Record<string, unknown>; enabled?: boolean; store?: Store;
  overrides?: Partial<SourceContextDeps> } = {}) {
  const board = new HealthBoard()
  const settings = SettingsSchema.parse({ sources: { gitlab: { enabled: options.enabled ?? true, config: options.config ?? {} } } })
  const sources = new SourceRegistry(() => settings, board)
  healthOf.set(sources, board)
  const value = host({ sources, ...options.overrides }, options.store)
  const reads = options.routes ? gitlab(value, options.routes) : []
  const disposers: (() => unknown)[] = []
  applyGitlab({ orchestrator: value, effect: (effect: () => () => unknown) => { disposers.push(effect()) } } as never)
  return { value, reads, stop: async (close = true) => { for (const dispose of disposers) await dispose(); if (close) value.store.close() } }
}
const bare = (reads: string[]) => reads.map(path => path.split('?')[0]!)

describe('gitlab source', () => {
  it('fills the config defaults and refuses an unknown key', () => {
    expect(gitlabKind.schema.parse({})).toEqual({ host: '', project: '', cli: '', pollSeconds: 60, failuresBeforeError: 3,
      observeIssues: false, observeMergeRequests: false, observeComments: false, observePipelines: false })
    expect(gitlabKind.schema.parse({ host: 'gitlab.local', project: 'acme/widgets', cli: '/bin/glab', observeComments: true }))
      .toMatchObject({ observeComments: true, observeIssues: false, pollSeconds: 60 })
    expect(() => gitlabKind.schema.parse({ observeEverything: true })).toThrow()
    expect(() => gitlabKind.schema.parse({ pollSeconds: 10 })).toThrow()
  })
  it('scopes each meta to the observation switch that admits it', () => {
    const config = gitlabKind.schema.parse({ observeIssues: true, observeComments: true })
    const scope = (meta: Record<string, unknown>) => gitlabKind.scope!({ meta }, config)
    expect(scope({ kind: 'issue' })).toEqual({ listened: true, observed: true, row: 'issues' })
    expect(scope({ kind: 'conversation' })).toEqual({ listened: true, observed: true, row: 'comments' })
    expect(scope({ kind: 'inline' })).toEqual({ listened: true, observed: true, row: 'comments' })
    expect(scope({ kind: 'mergeRequest' })).toEqual({ listened: true, observed: false, row: 'mergeRequests' })
    expect(scope({ kind: 'mergeRequest', ci: true })).toEqual({ listened: true, observed: false, row: 'pipelines' })
    expect(scope({ ci: true, ref: 'main' })).toEqual({ listened: true, observed: false, row: 'pipelines' })
    expect(scope({})).toEqual({ listened: true, observed: false })
  })
  it('finds a thread from an Issue number, a merge request number, or a project URL', () => {
    expect(gitlabKind.find!('#12')).toEqual({ threads: ['gitlab:issue:12'], terms: [] })
    expect(gitlabKind.find!('12')).toEqual({ threads: ['gitlab:issue:12'], terms: [] })
    expect(gitlabKind.find!('!12')).toEqual({ threads: ['gitlab:mr:12'], terms: [] })
    expect(gitlabKind.find!('http://gitlab.local/acme/widgets/-/issues/12#note_3')).toEqual({ threads: ['gitlab:issue:12'], terms: [] })
    expect(gitlabKind.find!('http://gitlab.local/acme/widgets/-/merge_requests/12')).toEqual({ threads: ['gitlab:mr:12'], terms: [] })
    expect(gitlabKind.find!('feature branch')).toEqual({ threads: [], terms: [] })
  })
  it('lists the admission rows and their cells for each observe switch', () => {
    const rows = gitlabKind.policy!.rows!({ observeIssues: true, observeComments: true })
    expect(rows.map(row => row.id)).toEqual(['issues', 'mergeRequests', 'comments', 'pipelines'])
    expect(rows[0]).toEqual({ id: 'issues', label: { zh: '新 Issue', en: 'New Issues' }, note: { zh: '全部', en: 'All' },
      cells: { listedUnaddressed: true, unlistedAddressed: true, unlistedUnaddressed: true } })
    expect(rows[1]).toEqual({ id: 'mergeRequests', label: { zh: '新合并请求', en: 'New merge requests' }, note: { zh: '仅 @', en: '@ only' },
      cells: { listedUnaddressed: false, unlistedAddressed: true, unlistedUnaddressed: false } })
    expect(rows[2]).toMatchObject({ note: { zh: '全部', en: 'All' }, cells: { listedUnaddressed: true, unlistedAddressed: true } })
    expect(rows[3]).toEqual({ id: 'pipelines', label: { zh: '默认分支的流水线', en: 'Default branch pipelines' },
      note: { zh: '不接收', en: 'Not received' },
      cells: { listedUnaddressed: false, unlistedAddressed: false, unlistedUnaddressed: false } })
    expect(gitlabKind.policy!.rows!({ observePipelines: true })[3]).toMatchObject({ note: { zh: '接收', en: 'Received' },
      cells: { unlistedUnaddressed: true } })
  })
  it('exposes the six environment values of a deployment and its trigger', () => {
    const config = gitlabKind.schema.parse({})
    expect(gitlabKind.environment!.variables.map(variable => variable.key)).toEqual(['DSH_SUPERAGENT_GITLAB_HOST',
      'DSH_SUPERAGENT_GITLAB_PROJECT', 'DSH_SUPERAGENT_GITLAB_ACCOUNT', 'DSH_SUPERAGENT_GITLAB_COMMIT_EMAIL',
      'DSH_SUPERAGENT_GITLAB_NUMBER', 'DSH_SUPERAGENT_GITLAB_MR_HEAD'])
    const values = (trigger?: Trigger) => gitlabKind.environment!.values({ deployment, config, trigger })
    expect(values()).toEqual({ DSH_SUPERAGENT_GITLAB_HOST: 'http://gitlab.local', DSH_SUPERAGENT_GITLAB_PROJECT: 'acme/widgets',
      DSH_SUPERAGENT_GITLAB_ACCOUNT: 'agent-bot', DSH_SUPERAGENT_GITLAB_COMMIT_EMAIL: '7-agent-bot@users.noreply.gitlab.local',
      DSH_SUPERAGENT_GITLAB_NUMBER: '', DSH_SUPERAGENT_GITLAB_MR_HEAD: '' })
    expect(values(mergeRequestTrigger(mergeRequest(9), 'agent-bot'))).toMatchObject({ DSH_SUPERAGENT_GITLAB_NUMBER: '9',
      DSH_SUPERAGENT_GITLAB_MR_HEAD: 'refs/merge-requests/9/head' })
    expect(values(issueTrigger(issue(12), 'agent-bot'))).toMatchObject({ DSH_SUPERAGENT_GITLAB_NUMBER: '12',
      DSH_SUPERAGENT_GITLAB_MR_HEAD: '' })
  })
  it('receives new Issues and merge requests, their notes and inline notes, and names each Thread', async () => {
    const store = new Store(join(mkdtempSync(join(tmpdir(), 'gitlab-')), 'db.sqlite'))
    store.set('gitlab-since', SINCE)
    store.tickets.save({ ...openTicket('t8'), follows: [{ thread: 'gitlab:mr:8', own: true }] })
    for (const [kind, number] of [['issue', 12], ['mergeRequest', 9], ['mergeRequest', 8]] as const) seedThread(store, kind, number)
    const started = start({ store, config: { observeIssues: true, observeMergeRequests: true, observeComments: true }, routes: {
      'projects/42/issues': [issue(12)],
      'projects/42/issues/12/notes': [note(100, '@agent-bot please take this'), note(101, 'mine', { author: { username: 'agent-bot' } }),
        note(102, 'added a label', { system: true })],
      'projects/42/merge_requests': [mergeRequest(9), mergeRequest(8, { state: 'merged', merged: true,
        merged_at: '2026-09-09T02:00:00Z', created_at: '2026-09-01T00:00:00Z', author: { username: 'agent-bot' } })],
      'projects/42/merge_requests/9/notes': [note(200, 'Please review')],
      'projects/42/merge_requests/9/discussions': [{ id: 'disc-1', notes: [note(201, 'Use the token',
        { position: { new_path: 'src/render.ts', new_line: 43 } })] }],
      'projects/42/merge_requests/8/notes': [], 'projects/42/merge_requests/8/discussions': [],
      'projects/42/merge_requests/8': mergeRequest(8, { state: 'merged', merged: true, merged_at: '2026-09-09T02:00:00Z',
        created_at: '2026-09-01T00:00:00Z', author: { username: 'agent-bot' } }),
    } })
    try {
      await vi.waitFor(() => expect(started.value.health.gitlab).toMatchObject({ state: 'ready' }))
      const received = started.value.receive.mock.calls.map(([trigger]) => trigger)
      expect(received.map(trigger => [trigger.meta.number, trigger.meta.kind, trigger.meta.isMr])).toEqual([
        [12, 'issue', false], [12, 'conversation', false], [9, 'mergeRequest', true], [9, 'conversation', true], [9, 'inline', true]])
      expect(received[4]!.meta).toMatchObject({ discussionId: 'disc-1', path: 'src/render.ts', line: 43, itemAuthor: 'carol' })
      expect(received[4]!.text).toBe('src/render.ts:43\n\nUse the token')
      expect(received.map(trigger => trigger.meta.noteId)).not.toContain(101)
      expect(received.map(trigger => trigger.meta.noteId)).not.toContain(102)
      const threads = (key: string) => store.threads.get(key)!.meta
      expect(threads('gitlab:issue:12')).toMatchObject({ number: 12, kind: 'issue', label: '#12 Login fails',
        url: 'http://gitlab.local/acme/widgets/-/issues/12', facts: { number: { value: '#12' } } })
      expect(threads('gitlab:mr:9')).toMatchObject({ number: 9, kind: 'mergeRequest', label: '!9 Fix the margin',
        url: 'http://gitlab.local/acme/widgets/-/merge_requests/9', facts: { number: { value: '#9' } } })
      expect(threads('gitlab:mr:8')).toMatchObject({ label: '!8 Fix the margin' })
      expect(store.tickets.get('t8')).toMatchObject({ follows: [{ thread: 'gitlab:mr:8', closed: { outcome: 'merged' } }] })
      expect(bare(started.reads)).toEqual(expect.arrayContaining(['projects/42/issues', 'projects/42/issues/12/notes',
        'projects/42/merge_requests', 'projects/42/merge_requests/9/notes', 'projects/42/merge_requests/9/discussions']))
      expect(started.reads.find(path => path.startsWith('projects/42/issues?'))).toContain(`updated_after=${encodeURIComponent(SINCE)}`)
      expect(store.get('gitlab-since')).not.toBe(SINCE)
      expect(Date.parse(String(store.get('gitlab-since')))).toBeGreaterThan(Date.parse(SINCE))
    } finally { await started.stop() }
  })
  it('leaves the updated_after cursor alone when a read fails, and reports the failure', async () => {
    const store = new Store(join(mkdtempSync(join(tmpdir(), 'gitlab-')), 'db.sqlite'))
    store.set('gitlab-since', SINCE)
    const started = start({ store, config: { observeIssues: true, failuresBeforeError: 1 },
      routes: { 'projects/42/issues': new Error('gitlab: Bad Gateway (HTTP 502)') } })
    try {
      await vi.waitFor(() => expect(started.value.health.gitlab).toMatchObject({ state: 'error', code: 'pollFailures',
        values: { count: '1', error: expect.stringContaining('Bad Gateway (HTTP 502)') } }))
      expect(store.get('gitlab-since')).toBe(SINCE)
    } finally { await started.stop() }
  })
  it('reports a merge request pipeline trigger only when its stored fingerprint changes', async () => {
    const store = new Store(join(mkdtempSync(join(tmpdir(), 'gitlab-')), 'db.sqlite'))
    store.tickets.save({ ...openTicket('t9'), follows: [{ thread: 'gitlab:mr:9', own: true }] })
    seedThread(store, 'mergeRequest', 9)
    const open = mergeRequest(9)
    const first = start({ store, routes: {
      'projects/42/merge_requests/9': open,
      'projects/42/merge_requests/9/pipelines': [{ id: 1, status: 'failed', sha: 'deadbeef' }],
      'projects/42/repository/commits/deadbeef/statuses': [{ status: 'failed', name: 'lint' }],
    } })
    try {
      await vi.waitFor(() => expect(first.value.health.gitlab).toMatchObject({ state: 'ready' }))
      expect(first.value.receive).not.toHaveBeenCalled()
      expect(store.get('gitlab-ci:gitlab:mr:9')).toMatchObject({ fingerprint: expect.stringContaining('deadbeef'), revision: 1 })
    } finally { await first.stop(false) }
    const second = start({ store, routes: {
      'projects/42/merge_requests/9': open,
      'projects/42/merge_requests/9/pipelines': [{ id: 2, status: 'success', sha: 'cafebabe' }],
      'projects/42/repository/commits/cafebabe/statuses': [{ status: 'success', name: 'lint' }],
    } })
    try {
      await vi.waitFor(() => expect(second.value.receive).toHaveBeenCalled())
      const trigger = second.value.receive.mock.calls[0]![0]
      expect(trigger).toMatchObject({ source: 'gitlab', threads: [{ source: 'gitlab', id: 'mr:9' }],
        meta: { number: 9, kind: 'mergeRequest', isMr: true, ci: true, revision: 2 } })
      expect(trigger.text).toContain('merge request !9')
      expect(store.get('gitlab-ci:gitlab:mr:9')).toMatchObject({ revision: 2 })
    } finally { await second.stop() }
  })
  it('waits for setup before polling', async () => {
    const pending = start({ overrides: { configured: () => false } })
    try {
      await vi.waitFor(() => expect(pending.value.health.gitlab).toMatchObject({ state: 'paused', code: 'setupPending' }))
    } finally { await pending.stop() }
  })
  it('reports sourceOff while the Source is disabled', async () => {
    const disabled = start({ enabled: false })
    try {
      await vi.waitFor(() => expect(disabled.value.health.gitlab).toMatchObject({ state: 'paused', code: 'sourceOff' }))
    } finally { await disabled.stop() }
  })
  it('reports polling failures only after failuresBeforeError rounds', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    try {
      vi.spyOn(Commands.prototype, 'run').mockRejectedValue(new Error('gitlab: Bad Gateway (HTTP 502)'))
      const failing = start({ config: { observeIssues: true, failuresBeforeError: 2 } })
      await vi.advanceTimersByTimeAsync(60_000)
      await vi.waitFor(() => expect(failing.value.health.gitlab).toMatchObject({ state: 'error', code: 'pollFailures',
        values: { count: '2', error: expect.stringContaining('Bad Gateway (HTTP 502)') } }))
      await failing.stop()
    } finally { vi.useRealTimers() }
  })
})
