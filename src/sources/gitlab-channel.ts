/** GitLab outbound channel: posts Issue and merge request notes, and discussion notes on a diff, under the agent account. */
import { z } from 'zod'
import type { OutboundMessage } from '../core/index.ts'
import { CliError } from '../infra/commands.ts'
import type { SourceContext } from './host.ts'
import type { ChannelLink, ChannelLinks } from './kind.ts'
import { DiscussionSchema, NoteSchema, gitlabAddress, gitlabPage, type Kind } from './gitlab-trigger.ts'

/** True when the target no longer accepts replies: the Issue or merge request is gone (404) or the project is read-only (403). */
const gone = (error: unknown): boolean => error instanceof CliError && (error.code === 404 || error.code === 403)
const kindOf = (address: Record<string, string>): Kind => address.kind === 'mergeRequest' ? 'mergeRequest' : 'issue'
/** Notes of a thread, without the activity lines GitLab writes itself. */
const notesAt = async (host: Pick<SourceContext, 'commands'>, path: string) => {
  const listed = await host.commands.gitlabPages(z.unknown(), `${path}/notes?sort=asc&order_by=created_at&per_page=100`)
  const tally = { skipped: 0 }
  const notes = listed.map(item => NoteSchema.safeParse(item)).flatMap(result => result.success ? [result.data] : [])
  return notes.filter(note => note.system !== true)
}
/**
 * Posts a note to an Issue, a merge request, or one of its discussions with an embedded HTML marker, so retries after a
 * lost response do not post the same reply twice. A deleted or read-only target returns `'gone'` rather than throwing.
 */
export async function sendGitlab(host: Pick<SourceContext, 'commands'>, message: OutboundMessage): Promise<'sent' | 'gone'> {
  const { commands } = host
  const { gitlab } = commands.deployment
  if (!gitlab) throw new Error('The GitLab Source is not configured')
  const project = commands.gitlabProject
  const number = Number(message.channel.address.number)
  if (!number) throw new Error('Missing GitLab reply target')
  const kind = kindOf(message.channel.address)
  const base = `projects/${project}/${kind === 'issue' ? 'issues' : 'merge_requests'}/${number}`
  const marker = `<!-- dsh-superagent:${message.id} -->`
  const mine = (note: z.infer<typeof NoteSchema>) => note.author.username === gitlab.login && (note.body ?? '').includes(marker)
  try {
    let discussion = message.channel.address.discussion
    // A reply retained by URL alone still routes to the discussion that holds the note it answers.
    if (!discussion && message.channel.address.url) {
      const address = gitlabAddress(message.channel.address.url, gitlab.host, gitlab.project)
      if (address?.note && address.kind === 'mergeRequest') {
        const discussions = await commands.gitlabPages(DiscussionSchema, `${base}/discussions?per_page=100`)
        discussion = discussions.find(item => item.notes.some(note => (note as { id?: number })?.id === address.note))?.id
      }
    }
    const path = discussion ? `${base}/discussions/${encodeURIComponent(discussion)}/notes` : `${base}/notes`
    if ((await notesAt(host, discussion ? `${base}/discussions/${encodeURIComponent(discussion)}` : base)).some(mine)) return 'sent'
    await commands.gitlabApi(z.unknown(), path, '--method', 'POST', '-f', `body=${message.text}\n\n${marker}`)
    return 'sent'
  } catch (error) {
    if (gone(error)) return 'gone'
    throw error
  }
}
/** Returns the web URL and label of a reply address, both when the deployment can build it and from a retained URL. */
export function gitlabLink(address: Record<string, string>, links: ChannelLinks): ChannelLink {
  const number = address.number ?? ''
  const kind = kindOf(address)
  const url = address.url ?? (links.gitlab ? gitlabPage(links.gitlab.url, links.gitlab.project, Number(number), kind) : '')
  return { url, label: kind === 'mergeRequest'
    ? { zh: `GitLab 合并请求 !${number}`, en: `GitLab merge request !${number}` }
    : { zh: `GitLab Issue #${number}`, en: `GitLab Issue #${number}` } }
}
