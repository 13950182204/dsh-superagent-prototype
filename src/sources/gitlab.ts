/** GitLab source kind definition, project polling loops, and Cordis plugin entry. */
import type { Context } from '@deepseek-ai/cordis'
import type { Ticket, Thread } from '../core/index.ts'
import { GitlabAccountsSchema } from '../deployment.ts'
import { validItems, type Tally } from '../infra/commands.ts'
import { KV } from '../kv.ts'
import { health, sourceContext, type SourceContext } from './host.ts'
import type { Localized, SourceKind } from './kind.ts'
import { pause, pollThreads as pollEach, cursorAt } from './poll.ts'
import { gitlabThread, gitlabAddress, gitlabChannel, gitlabPage, issueTrigger, mergeRequestPipelineTrigger, mergeRequestTrigger,
  noteTrigger, pipelineTrigger, DiscussionSchema, ItemSchema, MergeRequestSchema, NoteSchema, threadId, threadRef,
  type GitlabMergeRequest, type GitlabNote } from './gitlab-trigger.ts'
import { gitlabLink, sendGitlab } from './gitlab-channel.ts'
import { ciFact, ciSummary, commitCi, mergeRequestCi, gitlabThreadContext, readGitlab, type CiSnapshot } from './gitlab-read.ts'
import { mergeRequestsOf, observeMergeRequest } from './gitlab-merge-request.ts'
import { z } from 'zod'

export { readGitlab } from './gitlab-read.ts'
export const SOURCE = 'gitlab'

const GitlabConfigSchema = GitlabAccountsSchema.extend({
  pollSeconds: z.number().int().min(60).max(3600).default(60),
  failuresBeforeError: z.number().int().min(1).max(20).default(3),
  observeIssues: z.boolean().default(false), observeMergeRequests: z.boolean().default(false),
  observeComments: z.boolean().default(false), observePipelines: z.boolean().default(false),
}).strict()
export type GitlabConfig = z.infer<typeof GitlabConfigSchema>
const OBSERVED = { issues: 'observeIssues', mergeRequests: 'observeMergeRequests', comments: 'observeComments', pipelines: 'observePipelines' } as const
type Scope = keyof typeof OBSERVED
/** A configuration using every default, for the policy table and the config-less resolution paths. */
const DEFAULTS = GitlabConfigSchema.parse({})
function scopeOf(meta: Record<string, unknown>): Scope | undefined {
  if (meta.ci === true) return 'pipelines'
  if (meta.kind === 'issue') return 'issues'
  if (meta.kind === 'mergeRequest') return 'mergeRequests'
  return meta.kind === 'conversation' || meta.kind === 'inline' ? 'comments' : undefined
}
/** Reads the Issue or merge-request title from an item, which GitLab returns in `title`. */
const titleOf = (item: { title?: string | null }): string => item.title ?? ''
const webUrlOf = (item: { web_url?: string | null }): string | undefined => item.web_url ?? undefined

interface Round {
  started: string
  signal?: AbortSignal
  read: Set<string>
  tally: Tally
}
const stopped = (ctx: SourceContext, round: Round): boolean => round.signal?.aborted === true || ctx.config<GitlabConfig>(SOURCE) === undefined
/** Reads every page of an endpoint as schema-validated items, counting unparseable ones in the round tally. */
const pagesOf = <T>(ctx: SourceContext, item: z.ZodType<T>, path: string, round: Round): Promise<T[]> =>
  ctx.commands.gitlabPages(item, path, round.tally)

/** Publishes a Thread's label, URL, and the facts the panel and prompts show for it. */
function nameThread(ctx: SourceContext, kind: 'issue' | 'mergeRequest', number: number, title: string, url?: string): void {
  const label = kind === 'issue' ? `#${number} ${title}`.trim() : `!${number} ${title}`.trim()
  ctx.threads.patch(gitlabThread(kind, number), { number, kind, ...url ? { url } : {} })
  ctx.threads.describe(gitlabThread(kind, number), { label, ...url ? { url } : {}, facts: { number: { value: `#${number}` } } })
}

/** Notes of an Issue or merge request that arrived since `since`, skipping activity lines and the agent's own notes. */
async function intakeNotes(ctx: SourceContext, round: Round, kind: 'issue' | 'mergeRequest', item: { iid: number; web_url?: string | null,
  author?: { username: string }; updated_at?: string | null }, since: string): Promise<void> {
  const config = ctx.config<GitlabConfig>(SOURCE)
  if (!config?.observeComments) return
  const login = ctx.deployment.gitlab?.login ?? ''
  const base = `projects/${ctx.commands.gitlabProject}/${kind === 'issue' ? 'issues' : 'merge_requests'}/${item.iid}`
  const url = webUrlOf(item)
  const ref = { number: item.iid, url, kind, itemAuthor: item.author?.username }
  const conversation = async (): Promise<void> => {
    const notes = await pagesOf(ctx, z.unknown(), `${base}/notes?sort=asc&order_by=created_at&per_page=100`, round)
    const tally: Tally = { skipped: 0 }
    for (const note of validItems(NoteSchema, notes, tally)) {
      if (note.created_at && note.created_at < since) continue
      if (note.author.username === login) continue
      const trigger = noteTrigger(note, ref, 'conversation', login)
      if (trigger) await ctx.receive(trigger)
    }
    round.tally.skipped += tally.skipped
  }
  await conversation()
  // Inline discussion notes live in their own endpoint; only merge requests have a diff to comment on.
  if (kind !== 'mergeRequest') return
  const discussions = await pagesOf(ctx, DiscussionSchema, `${base}/discussions?per_page=100`, round)
  for (const discussion of discussions) {
    const notes: GitlabNote[] = validItems(NoteSchema, discussion.notes)
    const inline = notes.filter(note => note.position?.new_path != null)
    for (const note of inline) {
      if (note.created_at && note.created_at < since) continue
      if (note.author.username === login) continue
      const trigger = noteTrigger(note, { ...ref, discussion: discussion.id, url }, 'inline', login)
      if (trigger) await ctx.receive(trigger)
    }
  }
}

/** Closes tickets following an Issue or merge request that GitLab reports closed or merged. */
function closeThread(ctx: SourceContext, kind: 'issue' | 'mergeRequest', number: number, state: string, at: string): void {
  const outcome = state === 'merged' ? 'merged' as const : state === 'closed' ? 'closed' as const : undefined
  if (!outcome) return
  ctx.tickets.threadClosed({ source: SOURCE, id: threadId(kind, number) }, outcome, at)
}

/**
 * Reads the project's Issues and/or merge requests updated since the cursor, then each one's new notes, and closes the
 * Threads of those GitLab reports closed or merged. GitLab 13.1 has no notifications API or 304 support, so the
 * `updated_after` cursor and the Triggers' deterministic IDs do the deduplicating.
 */
async function pollProject(ctx: SourceContext, round: Round): Promise<string | undefined> {
  const config = ctx.config<GitlabConfig>(SOURCE)
  if (!config) return undefined
  const since = ctx.state.get(KV.gitlab.since) ?? cursorAt(new Date(Date.now() - 3600_000).toISOString())
  const login = ctx.deployment.gitlab?.login ?? ''
  const wanted: Array<{ kind: 'issue' | 'mergeRequest'; path: string; enabled: boolean }> = [
    { kind: 'issue', path: 'issues', enabled: config.observeIssues || config.observeComments },
    { kind: 'mergeRequest', path: 'merge_requests', enabled: config.observeMergeRequests || config.observeComments },
  ]
  for (const entry of wanted) {
    if (!entry.enabled) continue
    const path = `projects/${ctx.commands.gitlabProject}/${entry.path}?updated_after=${encodeURIComponent(since)}&state=all&sort=asc&order_by=updated_at&per_page=100`
    const items = await pagesOf(ctx, entry.kind === 'issue' ? ItemSchema : MergeRequestSchema, path, round)
    for (const item of items) {
      if (stopped(ctx, round)) return undefined
      const number = item.iid
      const url = webUrlOf(item)
      nameThread(ctx, entry.kind, number, titleOf(item), url)
      const created = item.created_at ?? ''
      const fresh = created >= since && item.author.username !== login
      if (fresh && entry.kind === 'issue' && config.observeIssues) await ctx.receive(issueTrigger(item, login))
      if (fresh && entry.kind === 'mergeRequest' && config.observeMergeRequests) await ctx.receive(mergeRequestTrigger(item, login))
      await intakeNotes(ctx, round, entry.kind, item, since)
      // A merge request also binds to the ticket whose branch opened it, and closes the tickets that followed it.
      if (entry.kind === 'mergeRequest') await observeMergeRequest(ctx, item as GitlabMergeRequest)
      else if ('state' in item) closeThread(ctx, entry.kind, number, item.state, item.updated_at ?? item.created_at ?? new Date().toISOString())
    }
  }
  return since
}

/** Reads the default branch's latest pipeline and emits a Trigger when its state or commit changes. */
async function pollBranchPipelines(ctx: SourceContext, round: Round): Promise<void> {
  const project = await ctx.commands.gitlabApi(z.looseObject({ default_branch: z.string().nullish() }), `projects/${ctx.commands.gitlabProject}`)
  const ref = project.default_branch ?? 'master'
  const pipelines = await ctx.commands.gitlabPages(z.looseObject({ id: z.number(), status: z.string(), sha: z.string().nullish(),
    web_url: z.string().nullish() }), `projects/${ctx.commands.gitlabProject}/pipelines?ref=${encodeURIComponent(ref)}&per_page=20`)
  const latest = [...pipelines].sort((a, b) => b.id - a.id)[0]
  if (!latest) return
  const sha = latest.sha ?? ''
  const stored = ctx.state.get(KV.gitlab.branch)
  if (stored?.sha === sha && stored.status === latest.status) return
  const revision = (stored?.revision ?? 0) + 1
  ctx.state.set(KV.gitlab.branch, { ref, sha, status: latest.status, revision })
  const snapshot: CiSnapshot = { head: sha, pipelines: [latest], statuses: [] }
  await ctx.receive(pipelineTrigger(ref, sha, revision, ciSummary(snapshot, `the ${ref} branch`, 'the pipelines'), latest.web_url ?? ''))
}

/**
 * Reads the pipelines of each open ticket's merge requests and reports a CI Trigger when they change. A merge request
 * GitLab reports merged or closed ends the tickets that follow it.
 */
async function pollTicketMergeRequests(ctx: SourceContext, round: Round): Promise<void> {
  const seen = new Set<number>()
  for (const ticket of ctx.tickets.open()) {
    for (const number of mergeRequestsOf(ticket)) {
      if (stopped(ctx, round)) return
      seen.add(number)
      const mr = await ctx.commands.gitlabApi(MergeRequestSchema, `projects/${ctx.commands.gitlabProject}/merge_requests/${number}`)
      if (await observeMergeRequest(ctx, mr)) continue
      const snapshot = await mergeRequestCi(ctx.commands, number, round.tally)
      const facts = { head: snapshot.head, pipelines: snapshot.pipelines.map(item => ({ id: item.id ?? null, status: item.status })),
        statuses: snapshot.statuses.map(status => ({ name: status.name ?? null, status: status.status })) }
      const fingerprint = JSON.stringify(facts)
      const stored = ctx.state.get(KV.gitlab.ci(gitlabThread('mergeRequest', number)))
      ctx.threads.describe(gitlabThread('mergeRequest', number), { facts: { ci: ciFact(snapshot) } })
      if (stored?.fingerprint === fingerprint) continue
      const revision = (stored?.revision ?? 0) + 1
      ctx.state.set(KV.gitlab.ci(gitlabThread('mergeRequest', number)), { fingerprint, revision })
      // The first read only records the current state: it must not report a pipeline that already passed as a change.
      if (!stored) continue
      const summary = ciSummary(snapshot, `merge request !${number}`, `gitlab/merge_requests/${number}`)
      await ctx.receive(mergeRequestPipelineTrigger({ number, url: gitlabPage(ctx.deployment.gitlab?.url ?? '', ctx.deployment.gitlab?.project ?? '', number, 'mergeRequest'),
        author: mr.author?.username }, snapshot.head, revision, summary))
    }
  }
  // A merge request no ticket follows any more keeps its last CI fingerprint, which a later ticket reuses.
  for (const name of ctx.state.keys(KV.gitlab.ci)) if (!seen.has(Number(name.slice(name.lastIndexOf(':') + 1)))) ctx.state.set(name, undefined)
}

/** Polls one subscribed Thread's notes after its own cursor and then moves the cursor forward. */
async function pollThread(ctx: SourceContext, round: Round, thread: Thread): Promise<void> {
  const ref = threadRef(thread.key)
  if (!ref?.kind) return
  const kind = ref.kind
  const base = `projects/${ctx.commands.gitlabProject}/${kind === 'issue' ? 'issues' : 'merge_requests'}/${ref.number}`
  const item = kind === 'issue' ? await ctx.commands.gitlabApi(ItemSchema, base) : await ctx.commands.gitlabApi(MergeRequestSchema, base)
  nameThread(ctx, kind, ref.number, titleOf(item), webUrlOf(item))
  const since = ctx.state.get(KV.gitlab.cursor(thread.key)) ?? new Date(Date.now() - 7 * 24 * 3600_000).toISOString()
  const login = ctx.deployment.gitlab?.login ?? ''
  const notes = await pagesOf(ctx, z.unknown(), `${base}/notes?sort=asc&order_by=created_at&per_page=100`, round)
  const tally: Tally = { skipped: 0 }
  let newest = since
  for (const note of validItems(NoteSchema, notes, tally)) {
    if (note.created_at && note.created_at > newest) newest = note.created_at
    if (note.created_at && note.created_at < since) continue
    if (note.author.username === login) continue
    const trigger = noteTrigger(note, { number: ref.number, url: webUrlOf(item), kind, itemAuthor: item.author?.username }, 'conversation', login)
    if (trigger) await ctx.receive(trigger)
  }
  round.tally.skipped += tally.skipped
  ctx.state.set(KV.gitlab.cursor(thread.key), newest)
  if ('state' in item) closeThread(ctx, kind, ref.number, item.state, item.updated_at ?? new Date().toISOString())
}

/** One polling pass: project reads, the default branch's pipeline, open tickets' merge request CI, then subscribed Threads. */
async function pollRound(ctx: SourceContext, signal: AbortSignal): Promise<number> {
  const started = new Date().toISOString()
  const round: Round = { started, signal, read: new Set(), tally: { skipped: 0 } }
  const config = ctx.config<GitlabConfig>(SOURCE)
  if (!config) return 60
  const since = await pollProject(ctx, round)
  if (config.observePipelines) await pollBranchPipelines(ctx, round)
  await pollTicketMergeRequests(ctx, round)
  await pollEach(ctx, SOURCE, () => stopped(ctx, round), thread => pollThread(ctx, round, thread),
    thread => { const ref = threadRef(thread.key); return !ref?.kind || mergeRequestsOf({ follows: ctx.tickets.open().flatMap(ticket => ticket.follows ?? []) }).includes(ref.number) })
  // Move the project cursor only after every read of this pass succeeded; overlapping Triggers deduplicate by ID.
  if (since) ctx.atomic(() => ctx.state.set(KV.gitlab.since, cursorAt(started)))
  const dropped = round.tally.skipped ? `; ${round.tally.skipped} unreadable records skipped` : ''
  ctx.report('gitlab', { state: 'ready', detail: `Read up to ${started}${dropped}`, at: started })
  return config.pollSeconds
}

/** Polls until the Source is disposed, reporting consecutive failures after `failuresBeforeError`. */
async function watch(ctx: SourceContext, signal: AbortSignal): Promise<void> {
  await ctx.ready
  let failures = 0
  while (!signal.aborted) {
    if (!ctx.configured()) { ctx.report('gitlab', health('paused', 'setupPending')); return }
    const config = ctx.config<GitlabConfig>(SOURCE)
    if (!config) { ctx.report('gitlab', health('paused', 'sourceOff')); await pause(60_000, signal); continue }
    try {
      const interval = await pollRound(ctx, signal)
      failures = 0
      await pause(Math.max(interval, config.pollSeconds) * 1000, signal)
    } catch (error) {
      if (signal.aborted) return
      failures += 1
      if (failures >= config.failuresBeforeError) ctx.report('gitlab', health('error', 'pollFailures', { count: String(failures), error: String(error) }))
      await pause(config.pollSeconds * 1000, signal)
    }
  }
}

/** The Source kind registered with the orchestrator; everything GitLab-specific is behind this descriptor. */
export const gitlabKind: SourceKind<GitlabConfig> = {
  kind: SOURCE,
  title: { zh: 'GitLab', en: 'GitLab' },
  description: { zh: '智能体的 GitLab 账号；接收项目里发给它的 Issue、合并请求讨论、CI 状态变化和合并请求的合并或关闭。', en: 'The agent\'s GitLab account; receives Issues addressed to it in the project, merge request discussion, CI changes, and merge request merges or closes.' },
  schema: GitlabConfigSchema,
  fields: [
    { key: 'host', type: 'text', pattern: '[A-Za-z0-9_.:\\-\\/]+', label: { zh: 'GitLab 服务器', en: 'GitLab server' },
      hint: { zh: '主机名、主机名:端口，或完整 URL（例如 http://192.168.11.238）。自建 GitLab 13.1 也可用。', en: 'A host name, host:port, or a full URL such as http://192.168.11.238. Self-hosted GitLab 13.1 works.' } },
    { key: 'project', type: 'text', pattern: '[A-Za-z0-9_.\\-]+(/[A-Za-z0-9_.\\-]+)+', label: { zh: '监听的项目', en: 'Project' },
      hint: { zh: '写作 namespace/path，可以带子组。这个来源接收这个项目的 Issue、合并请求和它们的讨论；保存时检查智能体账号能否推送到它，然后重启 dsh-superagent。', en: 'Written namespace/path, subgroups included. This Source receives the project\'s Issues, merge requests and their discussion; saving checks that the agent account can push to it, then restarts dsh-superagent.' } },
    { key: 'cli', type: 'text', label: { zh: '智能体的 GitLab CLI', en: 'Agent GitLab CLI' },
      hint: { zh: '命令名或绝对路径，通常是登录了智能体账号的 glab 包装脚本（用 --hostname 与凭据管理器保存登录态）。执行器以 glab 调用它。保存时检查它登录的账号能否推送到项目，然后重启 dsh-superagent。', en: 'A command name or absolute path, usually a glab wrapper signed in to the agent account (login is kept per hostname in the credential manager). The Executor calls it as glab. Saving checks that this account can push to the project, then restarts dsh-superagent.' } },
    { key: 'pollSeconds', type: 'number', advanced: true, min: 60, max: 3600, label: { zh: '轮询间隔 / 秒', en: 'Polling interval / seconds' },
      hint: { zh: 'GitLab 13.1 没有通知接口，只能按 updated_after 轮询；间隔越短，发现越及时。', en: 'GitLab 13.1 has no notifications API, so polling follows updated_after; a shorter interval notices changes sooner.' } },
    { key: 'failuresBeforeError', type: 'number', advanced: true, min: 1, max: 20, label: { zh: '连续失败几次后报告异常', en: 'Failed polls before reporting an error' },
      hint: { zh: '单次网络中断会在下一次轮询时自动重试，不必报告。', en: 'A single network interruption is retried on the next poll and need not be reported.' } },
    { key: 'observeIssues', type: 'switch', label: { zh: '接收项目里的新 Issue', en: 'Receive new Issues in the project' },
      hint: { zh: '打开后，没有 @ 智能体的新 Issue 也会收到，由策略的接收表决定是否成为候选。从打开的时候开始，不读以前的。', en: 'New Issues that do not mention the agent are received too, and the Policy\'s admission table decides whether they become candidates. Starts when switched on; earlier ones are not read.' } },
    { key: 'observeMergeRequests', type: 'switch', label: { zh: '接收项目里的新合并请求', en: 'Receive new merge requests in the project' },
      hint: { zh: '打开后，没有 @ 智能体的新合并请求也会收到，由策略的接收表决定是否成为候选。', en: 'New merge requests that do not mention the agent are received too, and the Policy\'s admission table decides whether they become candidates.' } },
    { key: 'observeComments', type: 'switch', label: { zh: '接收项目里的评论', en: 'Receive comments in the project' },
      hint: { zh: '打开后，Issue 和合并请求上没有 @ 智能体的评论和代码行评论也会收到，由策略的接收表决定是否成为候选。', en: 'Comments and line comments on Issues and merge requests that do not mention the agent are received too, and the Policy\'s admission table decides whether they become candidates.' } },
    { key: 'observePipelines', type: 'switch', label: { zh: '接收默认分支的流水线', en: 'Receive the default branch\'s pipelines' },
      hint: { zh: '打开后，默认分支的流水线失败和恢复会收到，由策略的接收表决定是否成为候选。', en: 'Failures of the default branch\'s pipelines, and their recovery, are received, and the Policy\'s admission table decides whether they become candidates.' } },
  ],
  scope: ({ meta }, config) => {
    const row = scopeOf(meta)
    return { listened: true, observed: row !== undefined && config[OBSERVED[row]], ...row ? { row } : {} }
  },
  health: ['gitlab'],
  channel: { send: sendGitlab, link: gitlabLink },
  threadContext: gitlabThreadContext,
  // `#12` names Issue 12, `!12` merge request 12, and a project URL names whichever it points at.
  find: query => {
    const text = query.trim()
    const mergeRequest = /^!(\d+)$/.exec(text) ?? /\/merge_requests\/(\d+)/.exec(text)
    if (mergeRequest) return { threads: [gitlabThread('mergeRequest', Number(mergeRequest[1]))], terms: [] }
    const issue = /^#?(\d+)$/.exec(text) ?? /\/issues\/(\d+)/.exec(text)
    return { threads: issue ? [gitlabThread('issue', Number(issue[1]))] : [], terms: [] }
  },
  policy: {
    schema: z.object({ allowed: z.array(z.object({ id: z.string().regex(/^[A-Za-z0-9_.-]{1,255}$/) }).strict()).default([]),
      bots: z.array(z.object({ id: z.string().regex(/^[A-Za-z0-9_.-]{1,255}$/) }).strict()).optional() }).strict(),
    fields: [{ key: 'allowed', type: 'rows', label: { zh: '能发起工作的 GitLab 账号', en: 'GitLab accounts that may originate work' },
      columns: [{ key: 'id', type: 'text', label: { zh: '账号', en: 'Account' }, pattern: '[A-Za-z0-9_.\\-]{1,255}' }] },
    { key: 'bots', type: 'rows', label: { zh: '评论可以成为候选的机器人', en: 'Bots whose comments may become candidates' },
      hint: { zh: '名单里的机器人账号的评论在来源收到时成为推断的候选，交给评估。它们不能发起明确的请求，也不能停止工单；其他机器人的评论不接收。', en: 'A comment of a bot account on this list becomes an inferred candidate for an assessment when the Source receives it. Such a comment never makes an explicit request or stops a ticket; other bots\' comments are not admitted.' },
      columns: [{ key: 'id', type: 'text', label: { zh: '账号', en: 'Account' }, pattern: '[A-Za-z0-9_.\\-]{1,255}' }] }],
    explicit: { zh: '名单里的账号在 Issue 或评论里 @ 智能体的账号。', en: 'An account on the list mentions the agent\'s account in an Issue or a comment.' },
    rows(stored) {
      const config = GitlabConfigSchema.partial().parse(stored)
      const note = (observed: boolean | undefined) => observed ? { zh: '全部', en: 'All' } : { zh: '仅 @', en: '@ only' }
      const row = (id: Scope, label: Localized) => ({ id, label, note: note(config[OBSERVED[id]]),
        cells: { listedUnaddressed: !!config[OBSERVED[id]], unlistedAddressed: true, unlistedUnaddressed: !!config[OBSERVED[id]] } })
      return [row('issues', { zh: '新 Issue', en: 'New Issues' }), row('mergeRequests', { zh: '新合并请求', en: 'New merge requests' }),
        row('comments', { zh: '评论', en: 'Comments' }),
        { id: 'pipelines', label: { zh: '默认分支的流水线', en: 'Default branch pipelines' },
          note: config.observePipelines ? { zh: '接收', en: 'Received' } : { zh: '不接收', en: 'Not received' },
          cells: { listedUnaddressed: false, unlistedAddressed: false, unlistedUnaddressed: !!config.observePipelines } }]
    },
  },
  environment: {
    variables: [
      { key: 'DSH_SUPERAGENT_GITLAB_HOST', description: { zh: '这个来源的 GitLab 服务器地址，例如 http://192.168.11.238；glab 用 --hostname 指定', en: 'This Source\'s GitLab server, such as http://192.168.11.238; pass it to glab as --hostname' } },
      { key: 'DSH_SUPERAGENT_GITLAB_PROJECT', description: { zh: '这个来源监听的项目，namespace/path。智能体在这里开的合并请求，分支最后一段是 DSH_SUPERAGENT_NAME 时（例如 agent/$DSH_SUPERAGENT_NAME）会关联到工单', en: 'The project this Source watches, as namespace/path. A merge request the agent opens here from a branch whose last path segment is DSH_SUPERAGENT_NAME (for example agent/$DSH_SUPERAGENT_NAME) binds to the ticket' } },
      { key: 'DSH_SUPERAGENT_GITLAB_ACCOUNT', description: { zh: '智能体的 GitLab 账号；glab 以它登录，除自动合并外的 GitLab 操作都用 glab，不用其他账号或凭据', en: 'The agent\'s GitLab account. glab is signed in to it; use glab for every GitLab operation except auto-merge, and never another account or credential' } },
      { key: 'DSH_SUPERAGENT_GITLAB_COMMIT_EMAIL', description: { zh: '智能体账号的提交邮箱。这里的 git 没有身份：按提示词写明的作者提交，没有写明时用智能体账号和这个邮箱', en: 'Commit email of the agent\'s account. git has no identity here: commit as the author these instructions name, or as the agent\'s account with this email when they name none' } },
      { key: 'DSH_SUPERAGENT_GITLAB_NUMBER', description: { zh: '接下工单的 Issue 或合并请求编号；工单不是从 GitLab 来的时为空', en: 'Number of the Issue or merge request that started the ticket; empty when the ticket did not start on GitLab' } },
      { key: 'DSH_SUPERAGENT_GITLAB_MR_HEAD', description: { zh: '接下工单的合并请求的 head 引用 refs/merge-requests/<编号>/head；不是合并请求时为空', en: 'Head ref refs/merge-requests/<number>/head of the merge request that started the ticket; empty when it was not a merge request' } },
    ],
    values: ({ deployment, trigger }) => {
      const gitlab = deployment.gitlab
      const number = trigger?.threads[0]?.source === SOURCE ? Number(trigger.meta.number) || 0 : 0
      return { DSH_SUPERAGENT_GITLAB_HOST: gitlab?.url ?? '', DSH_SUPERAGENT_GITLAB_PROJECT: gitlab?.project ?? '',
        DSH_SUPERAGENT_GITLAB_ACCOUNT: gitlab?.login ?? '', DSH_SUPERAGENT_GITLAB_COMMIT_EMAIL: gitlab?.noreply ?? '',
        DSH_SUPERAGENT_GITLAB_NUMBER: number ? String(number) : '',
        DSH_SUPERAGENT_GITLAB_MR_HEAD: number && trigger?.meta.isMr === true ? `refs/merge-requests/${number}/head` : '' }
    },
  },
  facts: (deployment): Record<string, Localized | string> => deployment?.gitlab ? {
    project: { zh: `${deployment.gitlab.host} 上的 ${deployment.gitlab.project}`, en: `${deployment.gitlab.project} on ${deployment.gitlab.host}` },
    cli: { zh: `当前账号 @${deployment.gitlab.login}`, en: `Current account @${deployment.gitlab.login}` },
  } : {},
}

export const name = 'dsh-superagent-gitlab'
export const inject = ['orchestrator']
/** Registers the GitLab Source kind and starts its polling loop as one Cordis plugin. */
export function apply(ctx: Context): void {
  const orchestrator = (ctx as unknown as { orchestrator: { sources: { register(kind: SourceKind<GitlabConfig>): () => void };
    context(kind: { kind: string; health: readonly string[] }): SourceContext; ready: Promise<void> } }).orchestrator
  ctx.effect(() => orchestrator.sources.register(gitlabKind), 'gitlab: source kind')
  ctx.effect(() => {
    const controller = new AbortController()
    const source = sourceContext({ sources: orchestrator.sources as never, context: (kind: { kind: string; health: readonly string[] }) => orchestrator.context(kind) },
      gitlabKind)
    const done = watch(source, controller.signal).catch(error => { source.report('gitlab', { state: 'error', detail: String(error) }) })
    return () => { controller.abort(); return done }
  }, 'gitlab: polling loop')
}
