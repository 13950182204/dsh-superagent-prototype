/**
 * Process environment and CLI shims that bind git, gh, and lark-cli to the deployment's accounts and block disallowed commands.
 * Variables read by workers avoid `KEY|PASSWORD|SECRET|TOKEN` in their names because DSH strips credential-shaped variables from child environments.
 * Provides default-path guardrails rather than an OS-level security boundary, as workers run under the operator's OS user.
 */
import { lstat, mkdir, readdir, readFile, rename, unlink, writeFile } from 'node:fs/promises'
import { delimiter, join } from 'node:path'
import type { SubprocessOutputReader, SubprocessRuntime } from '@deepseek-ai/dsh-subprocess'
import type { Deployment } from '../deployment.ts'
import { SetupError } from '../setup.ts'
import { CliError } from './commands.ts'
import { gitPath, sameDirectory, withoutDirectory } from './paths.ts'

export { sameDirectory, withoutDirectory }

const MARKER = '# Written by dsh-superagent on every start; edits are lost.'
/** Markers of files written under the project's earlier names (`dsh-tag`, `dsh-go`, `dsh-freelancer`), which `dsh-superagent` owns and replaces too. */
const LEGACY_MARKERS = ['dsh-tag', 'dsh-go', 'dsh-freelancer'].map(name => `# Written by ${name} on every start; edits are lost.`)
/** Commands workers need, which `blockedCommands` cannot block: the shims and git. */
export const WORKER_COMMANDS: readonly string[] = ['gh', 'git', 'lark-cli']
export const workerBin = (stateDir: string): string => join(stateDir, 'worker-bin')
export const workerGitConfig = (stateDir: string): string => join(stateDir, 'worker-gitconfig')
const shellQuote = (value: string): string => `'${value.replaceAll("'", "'\\''")}'`
const gitQuote = (value: string): string => `"${value.replace(/[\\"]/g, char => `\\${char}`)}"`
export const credentialHelper = (cli: string): string => `!${shellQuote(gitPath(cli))} auth git-credential`

/**
 * The CLI accounts git may authenticate as, each with the URL prefix git reads the credential helper from.
 * The GitHub account always takes one entry; a GitLab account adds its own host when that Source is configured.
 */
export function credentialAccounts(deployment: Pick<Deployment, 'github'>): Array<{ url: string; cli: string }> {
  return [{ url: 'https://github.com', cli: deployment.github.cli }]
}


/**
 * The variables that tell git which repository, work tree and index to act on. A host started inside git, such as by
 * `git rebase --exec`, passes them on, and a git started below it would act on that repository. GIT_CEILING_DIRECTORIES is
 * kept: it names no repository, and it stops git's search for one where the operator chose.
 */
export const GIT_LOCATION: readonly string[] = ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE', 'GIT_PREFIX', 'GIT_COMMON_DIR', 'GIT_OBJECT_DIRECTORY',
  'GIT_ALTERNATE_OBJECT_DIRECTORIES', 'GIT_NAMESPACE']

/**
 * Returns environment variable overrides that strip ambient GitHub tokens, interactive prompts, the repository the host's own
 * environment may name, and operator git identity/config overrides.
 */
export function agentVariables(stateDir: string): Record<string, string | undefined> {
  return {
    GH_TOKEN: undefined, GITHUB_TOKEN: undefined,
    // A worker's git finds the repository from its directory, never from the host's environment.
    ...Object.fromEntries(GIT_LOCATION.map(name => [name, undefined])),
    GIT_CONFIG_GLOBAL: workerGitConfig(stateDir), GIT_CONFIG_NOSYSTEM: '1',
    // Clear environment git config overrides; configuration passed through the environment would otherwise reach every git command the agent runs.
    GIT_CONFIG_COUNT: undefined, GIT_CONFIG_PARAMETERS: undefined,
    // When the credential helper has no answer, git must fail rather than prompt; `GIT_ASKPASS: ''` also overrides `core.askPass` and `SSH_ASKPASS`.
    GIT_ASKPASS: '', SSH_ASKPASS: undefined, GIT_TERMINAL_PROMPT: '0',
    // Clear operator commit identity variables; prompts specify commit identity and operator env vars would override what a worker sets.
    GIT_AUTHOR_NAME: undefined, GIT_COMMITTER_NAME: undefined, GIT_AUTHOR_EMAIL: undefined, GIT_COMMITTER_EMAIL: undefined,
  }
}

/** True when a regular file starts with the dsh-superagent marker in its first two lines; a symbolic link, directory, or other non-regular file never counts as written by dsh-superagent. */
async function written(file: string): Promise<boolean> {
  if (!(await lstat(file)).isFile()) return false
  // A Windows shim spells the same marker as a `rem` comment line.
  const head = (await readFile(file, 'utf8')).split('\n', 2).map(line => line.trim().replace(/^rem\s+/i, ''))
  return [MARKER, ...LEGACY_MARKERS].some(marker => head.includes(marker))
}
async function own(file: string, text: string, mode = 0o644): Promise<void> {
  let foreign = false
  try { foreign = !await written(file) } catch { /* The file does not exist yet. */ }
  if (foreign) throw new SetupError('foreignFile', { file })
  const temporary = `${file}.${process.pid}.tmp`
  await writeFile(temporary, text, { mode })
  await rename(temporary, file)
}

/**
 * Atomically writes worker CLI shims and the isolated git configuration file into the state directory, refusing to overwrite foreign files.
 * A POSIX shim is a `sh` script; a Windows shim is a `.cmd` batch file, because `cmd` and PowerShell resolve `.cmd` by name.
 * Both strip the shim directory from PATH before running the real CLI so a wrapper script that calls `gh` or `lark-cli` by name reaches the binary.
 */
export async function writeEnvironment(deployment: Pick<Deployment, 'stateDir' | 'github' | 'feishu'>, blockedCommands: readonly string[]): Promise<void> {
  const { stateDir, github, feishu } = deployment
  const dir = workerBin(stateDir)
  await mkdir(dir, { recursive: true })
  const before = await readdir(dir)
  for (const name of before) { const file = join(dir, name); if (!await written(file)) throw new SetupError('foreignFile', { file }) }
  const windows = process.platform === 'win32'
  // Workers may be running concurrently: write each shim to a temp file and atomically rename it so no command ever resolves past the shim directory.
  const kept = new Set<string>()
  const keep = (name: string): string => { const file = windows ? `${name}.cmd` : name; kept.add(file); return file }
  const shim = async (name: string, posix: string, batch: string): Promise<void> => {
    const file = keep(name)
    const text = windows ? `@echo off\r\nrem ${MARKER}\r\n${batch}\r\n` : `#!/bin/sh\n${MARKER}\n${posix}\n`
    const temporary = join(dir, `.${file}.${process.pid}.tmp`)
    await writeFile(temporary, text, { mode: 0o755 })
    await rename(temporary, join(dir, file))
  }
  const withoutShims = [
    `self=${shellQuote(dir)}`, 'rest=', 'IFS=:', 'set -f',
    'for entry in $PATH; do [ "$entry" = "$self" ] || rest="${rest:+$rest:}$entry"; done',
    'set +f', 'unset IFS', 'PATH=$rest', 'export PATH',
  ].join('\n')
  const posixRun = (program: string): string => `${withoutShims}\nexec ${shellQuote(program)} "$@"`
  const posixFail = (message: string): string => `echo ${shellQuote(message)} >&2\nexit 1`
  const batchRun = (program: string): string => [
    'setlocal EnableDelayedExpansion',
    'set "SELF=%~dp0"', 'set "SELF=!SELF:~0,-1!"', 'set "REST="',
    'for %%P in ("%PATH:;=" "%") do (',
    '  if not "%%~P"=="" if /I not "%%~P"=="!SELF!" set "REST=!REST!;%%~P"',
    ')',
    'if defined REST set "PATH=!REST:~1!"',
    `"${program}" %*`,
    'exit /b %ERRORLEVEL%',
  ].join('\r\n')
  const batchFail = (message: string): string => `echo ${message} 1>&2\r\nexit /b 1`
  await shim('gh', posixRun(github.cli), batchRun(github.cli))
  if (feishu) await shim('lark-cli', posixRun(feishu.cli), batchRun(feishu.cli))
  else {
    const message = 'lark-cli is unavailable: this installation has no Feishu bot.'
    await shim('lark-cli', posixFail(message), batchFail(message))
  }
  for (const name of new Set(blockedCommands.filter(name => !WORKER_COMMANDS.includes(name)))) {
    const message = `${name} is blocked in this installation; use gh, which acts as ${github.login}.`
    await shim(name, posixFail(message), batchFail(message))
  }
  for (const name of before) if (!kept.has(name)) await unlink(join(dir, name))
  const accounts = credentialAccounts(deployment)
  const config = [
    MARKER,
    // Make git refuse to commit without an explicit identity set by the worker instead of guessing from the operator's OS user.
    '[user]', '\tuseConfigOnly = true',
    '[credential]', '\thelper =',
    ...accounts.flatMap(({ url, cli }) => [`[credential "${url}"]`, `\thelper = ${gitQuote(credentialHelper(cli))}`]),
    // Read the same repositories over HTTPS so the credential helper answers; workers have no SSH agent or key of their own.
    ...accounts.flatMap(({ url }) => [`[url "${url}/"]`, `\tinsteadOf = git@${new URL(url).hostname}:`, `\tinsteadOf = ssh://git@${new URL(url).hostname}/`]),
    // Include Git LFS filters because the operator's global gitconfig (which usually holds them) is ignored.
    '[filter "lfs"]', '\tclean = git-lfs clean -- %f', '\tsmudge = git-lfs smudge -- %f', '\tprocess = git-lfs filter-process', '\trequired = true',
  ]
  await own(workerGitConfig(stateDir), config.join('\n') + '\n')
}

/** Applies environment overrides and prepends worker shims to `process.env.PATH`, returning a restore callback. */
export function applyEnvironment(variables: Record<string, string | undefined>, stateDir: string, path: string): () => void {
  const values = { ...variables, PATH: [workerBin(stateDir), path].join(delimiter) }
  const previous = Object.fromEntries(Object.keys(values).map(name => [name, process.env[name]]))
  const apply = (env: Record<string, string | undefined>): void => { for (const [name, value] of Object.entries(env)) { if (value === undefined) delete process.env[name]; else process.env[name] = value } }
  apply(values)
  return () => { apply(previous) }
}

/** Spawns a command through the DSH subprocess runtime, which strips credential-shaped environment variables. */
export async function runAsWorker(subprocess: SubprocessRuntime, argv: string[], cwd: string, signal: AbortSignal, env?: Record<string, string>): Promise<string> {
  const handle = subprocess.spawn({ argv, cwd, graceMs: 2000, signal, ...env ? { env } : {}, stdio: { stdin: 'ignore', stdout: { maxBytes: 1 << 20 }, stderr: { maxBytes: 1 << 16 } } })
  const { exitCode } = await handle.done
  const read = (reader: SubprocessOutputReader | undefined): string => reader?.readFrom(0).text ?? ''
  if (exitCode === 0) return read(handle.collected.stdout)
  const ended = exitCode === null ? 'was stopped before it finished' : `exited with ${exitCode}`
  throw new CliError(read(handle.collected.stderr).trim() || `${argv.join(' ')} ${ended}`, undefined, exitCode ?? undefined)
}

/** Verifies that worker git invocations resolve each configured account's credential helper from the worker git configuration. */
export async function verifyEnvironment(deployment: Pick<Deployment, 'github' | 'stateDir'>, subprocess: SubprocessRuntime, signal: AbortSignal): Promise<void> {
  const { stateDir } = deployment
  const expected = `file:${gitPath(workerGitConfig(stateDir))}`
  for (const { url, cli } of credentialAccounts(deployment)) {
    // `-z` separates fields with NUL and never quotes paths.
    const helpers = (await runAsWorker(subprocess, ['git', 'config', '-z', '--show-origin', '--get-all', `credential.${url}.helper`], stateDir, AbortSignal.any([signal, AbortSignal.timeout(60_000)])).catch(() => '')).split('\0')
    if (helpers.join('\0') !== [expected, credentialHelper(cli), ''].join('\0')) throw new SetupError('gitTooOld')
  }
}

/**
 * Verifies that a ticket directory's local or worktree git config defines no custom `credential.*` or `http.*extraheader`
 * keys, which the agent's git would read from the repository's own config and act on.
 */
export async function verifyDirectory(directory: string, subprocess: SubprocessRuntime, signal: AbortSignal): Promise<void> {
  const keys = ['git', 'config', '-z', '--show-scope', '--get-regexp', '^(credential\\..*|http\\..*extraheader)$']
  // `git config --get-regexp` exits with code 1 when no keys match.
  const output = await runAsWorker(subprocess, keys, directory, AbortSignal.any([signal, AbortSignal.timeout(60_000)]))
    .catch((error: unknown) => { if (error instanceof CliError && error.exitCode === 1) return ''; throw error })
  const scoped = output.split('\0')
  const local = scoped.flatMap((scope, index) => index % 2 === 0 && (scope === 'local' || scope === 'worktree') ? [scoped[index + 1]!.split('\n')[0]!] : [])
  if (local.length) throw new Error(`The git configuration of the repository in ${directory} sets ${local.join(', ')}, which the agent's git would also read; remove them.`)
}
