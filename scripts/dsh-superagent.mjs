#!/usr/bin/env node
/**
 * Manage a local dsh-superagent service (one DSH profile, default `superagent`) without affecting other tmux sessions.
 *
 * `status`, `start`, and `restart` exit 0 while the service runs normally; 1 when it is stopped, duplicated, unreachable, or
 * reporting a runtime error, which `restart` may fix; 2 when it runs while a component such as a Source reports an error;
 * and 3 when it runs and waits for setup. A restart fixes neither 2 nor 3: they need a person.
 *
 * POSIX runs the service in the profile's tmux session. Windows has neither tmux nor POSIX signals, so it starts the DSH
 * executable directly (one visible log file), pauses the Executor, waits for running Sessions to finish, and then ends the
 * process tree; the same subcommands, exit codes, control directory, and log names apply on both platforms.
 */
import { execFileSync, spawn } from 'node:child_process'
import { existsSync, mkdirSync, openSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { get as httpGet, request as httpRequest } from 'node:http'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import lockfile from 'proper-lockfile'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const ARTIFACTS = join(ROOT, '.artifacts')
const CONTROL = join(ARTIFACTS, 'control')
const KEEP_LOGS = 20
const PART_ERROR = 2
const SETUP_WAITS = 3
const WINDOWS = process.platform === 'win32'

/** Return the control directory for `profile`, creating it if needed. */
function control(profile) {
  const directory = join(CONTROL, 'profiles', profile)
  mkdirSync(directory, { recursive: true, mode: 0o700 })
  return directory
}

/** Return whether `profile` was intentionally stopped. */
function stopped(profile) {
  return existsSync(join(control(profile), 'manually-stopped'))
}

const escape = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/**
 * Return whether a service command line serves `profile`.
 * A `dsh plugin --profile <profile> …` invocation manages the profile rather than serving it, so it never counts.
 */
function serves(text, profile) {
  const directory = '(?:^|\\s)--profile(?:=|\\s+)("?)' + escape(profile) + '\\1(?:\\s|$)'
  return new RegExp(directory).test(text) && !/(?:^|\s)plugin(?:\s|$)/.test(text)
}

/** On Windows a service runs as the desktop executable rather than as `node` or `dsh`. */
const name = (comm) => WINDOWS ? /deepseek harness|(?:^|[/\\])dsh(?:\.cmd)?$|^node(?:\.exe)?$/i.test(comm) : comm === 'node' || comm === 'dsh'

/** List `(pid, one-line command)` pairs of running processes on this platform. */
function listProcesses(pid) {
  if (WINDOWS) {
    const filter = pid === undefined ? '' : ` -Filter "ProcessId = ${pid}"`
    const command = `Get-CimInstance Win32_Process${filter} | Select-Object ProcessId,Name,CommandLine | ConvertTo-Json -Compress`
    let text
    try { text = execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', command], { encoding: 'utf8' }) } catch { return [] }
    let value
    try { value = JSON.parse(text.trim() || '[]') } catch { return [] }
    return [value].flat().filter(entry => entry && typeof entry.ProcessId === 'number' && typeof entry.CommandLine === 'string')
      .map(entry => ({ pid: entry.ProcessId, comm: String(entry.Name ?? ''), text: entry.CommandLine }))
  }
  const argv = pid === undefined ? ['-ww', '-ax', '-o', 'pid=,ucomm=,args='] : ['-ww', '-p', String(pid), '-o', 'pid=,ucomm=,args=']
  let text
  try { text = execFileSync('ps', argv, { encoding: 'utf8' }) } catch { return [] }
  const found = []
  for (const line of text.split('\n')) {
    const parts = /^\s*(\d+)\s+(\S+)\s+(.*)$/.exec(line)
    if (parts) found.push({ pid: Number(parts[1]), comm: parts[2], text: parts[3] })
  }
  return found
}

/** Return whether `pid` is currently running the DSH service for `profile`. */
function running(pid, profile) {
  return listProcesses(pid).some(entry => entry.pid === pid && name(entry.comm) && serves(entry.text, profile))
}

/**
 * Return PIDs of all running DSH service processes for `profile`, including instances started outside this script and the
 * recorded `service.pid` while still running.
 */
function processes(profile) {
  const found = listProcesses().filter(entry => name(entry.comm) && serves(entry.text, profile)).map(entry => entry.pid)
  let recorded
  try { recorded = Number(readFileSync(join(control(profile), 'service.pid'), 'utf8').trim()) } catch { return found }
  return Number.isInteger(recorded) && !found.includes(recorded) && running(recorded, profile) ? [...found, recorded] : found
}

/** Fetch one management API answer, or return undefined when the service does not answer. */
async function fetchState(url, path) {
  return new Promise(resolve => {
    const request = httpGet(url.replace(/\/+$/, '') + path, { headers: { 'x-orchestrator-request': '1' }, timeout: 2_000 }, response => {
      const chunks = []
      response.on('data', chunk => chunks.push(chunk))
      response.on('end', () => {
        try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))) } catch { resolve(undefined) }
      })
    })
    request.on('timeout', () => request.destroy())
    request.on('error', () => resolve(undefined))
  })
}

/** Fetch health and setup status from the management API, or return undefined if unreachable. */
async function state(url) {
  const value = await fetchState(url, '/orchestrator/api/state')
  if (!value || typeof value !== 'object') return undefined
  // Keys omitted by another version read as empty so the service is not mistaken for unreachable.
  const health = value.health && typeof value.health === 'object' ? value.health : {}
  const setup = value.setup && typeof value.setup === 'object' ? value.setup : {}
  const entries = Object.fromEntries(Object.entries(health).map(([key, entry]) => [key, entry && typeof entry === 'object' ? entry : {}]))
  const load = value.load && typeof value.load === 'object' ? value.load : undefined
  return {
    health: Object.fromEntries(Object.entries(entries).map(([key, entry]) => [key, entry.state])),
    errors: Object.fromEntries(Object.entries(entries).filter(([, entry]) => entry.state === 'error').map(([key, entry]) => [key, String(entry.detail ?? '')])),
    setup: setup.problem ?? null, feishu: setup.feishuProblem ?? null,
    runningSessions: load && typeof load.running === 'number' ? load.running : undefined,
  }
}

/** Return whether the runtime is ready or paused awaiting operator action; a component still starting does not hold this up. */
const runtimeUp = (current) => current !== undefined && (current.health.runtime === 'ready' || current.health.runtime === 'paused')

/** Return non-runtime components that are in an error state. */
const partErrors = (current) => Object.fromEntries(Object.entries(current.errors).filter(([key]) => key !== 'runtime').sort(([left], [right]) => left.localeCompare(right)))

/** Compute the CLI exit code from running PIDs and management API state. */
function outcome(pids, current) {
  if (pids.length !== 1 || !runtimeUp(current)) return 1
  if (current.setup) return SETUP_WAITS
  // A component's lasting error, unlike a Feishu bot check that failed during setup, requires operator action.
  return Object.keys(partErrors(current)).length ? PART_ERROR : 0
}

/** Print the status document and return its exit code. */
async function status(args) {
  const pids = processes(args.profile)
  const current = pids.length ? await state(args.url) : undefined
  process.stdout.write(JSON.stringify({
    pids, cwd: ROOT, url: args.url, manually_stopped: stopped(args.profile),
    health: current ? current.health : null, errors: current ? current.errors : null,
    setup: current ? current.setup : null, feishu: current ? current.feishu : null,
  }, null, 2) + '\n')
  return outcome(pids, current)
}

/** Ask the Executor to stop taking work so running Sessions can finish their step. */
async function pause(url) {
  await new Promise(resolve => {
    const target = new URL(url.replace(/\/+$/, '') + '/orchestrator/api/executor/pause')
    const request = httpRequest(target, { method: 'POST', headers: { 'x-orchestrator-request': '1', 'content-type': 'application/json' }, timeout: 2_000 }, response => { response.resume(); response.on('end', resolve) })
    request.on('timeout', () => request.destroy())
    request.on('error', resolve)
    request.end(JSON.stringify({ paused: true }))
  })
}

/** End the process tree of one service process. */
function endTree(pid) {
  if (WINDOWS) execFileSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore' })
  else process.kill(pid, 'SIGINT')
}

/** Wait until `predicate` holds, polling every half second. */
async function until(predicate, seconds, message) {
  const deadline = Date.now() + seconds * 1_000
  while (!(await predicate())) {
    if (Date.now() >= deadline) throw new Error(message)
    await new Promise(resolve => setTimeout(resolve, 500))
  }
}

/**
 * Stop the service, recording a manual stop marker when `intentional` is true.
 * Windows cannot deliver SIGINT to a GUI-subsystem executable, so it pauses the Executor, drains running Sessions, and
 * then ends the tree; a drain timeout leaves the process running, exactly like a timeout of the graceful POSIX stop.
 */
async function stop(args, intentional = true) {
  const pids = processes(args.profile)
  if (pids.length > 1) throw new Error('Multiple dsh-superagent processes found; refusing to choose one.')
  // Write the stop marker before waiting so monitors respect the intentional stop even if graceful shutdown times out.
  if (intentional) writeFileSync(join(control(args.profile), 'manually-stopped'), new Date().toISOString() + '\n', { mode: 0o600 })
  if (WINDOWS) {
    for (const pid of pids) {
      await pause(args.url)
      try {
        await until(async () => {
          const current = await state(args.url)
          return !running(pid, args.profile) || current === undefined || current.runningSessions === 0
        }, args.stopTimeout, 'Graceful stop timed out; no forced kill was sent. Check status.')
        if (running(pid, args.profile)) endTree(pid)
        await until(() => !running(pid, args.profile), Math.min(args.stopTimeout, 30), 'The stopped process did not exit; check status.')
      } catch (error) {
        // A process that already exited needs no tree to end.
        if (running(pid, args.profile)) throw error
      }
    }
  } else {
    for (const pid of pids) process.kill(pid, 'SIGINT')
    await until(() => !pids.some(pid => running(pid, args.profile)), args.stopTimeout, 'Graceful stop timed out; no forced kill was sent. Check status.')
  }
  rmSync(join(control(args.profile), 'service.pid'), { force: true })
  console.log(intentional ? 'dsh-superagent stopped. Automatic recovery is paused until start/restart.' : 'dsh-superagent stopped.')
}

/** Return whether the profile's tmux session already exists. */
function hasSession(session) {
  try { execFileSync('tmux', ['has-session', '-t', '=' + session], { stdio: 'ignore' }); return true } catch { return false }
}

/** Retain only the newest `KEEP_LOGS` log files for `profile`. */
function pruneLogs(profile) {
  const pattern = new RegExp('^' + escape(`dsh-superagent-${profile}-`) + '\\d{8}-\\d{6}-\\d+\\.log$')
  const logs = readdirSync(ARTIFACTS)
    .filter(name => pattern.test(name))
    .map(name => ({ file: join(ARTIFACTS, name), time: statSync(join(ARTIFACTS, name)).mtimeMs }))
    .sort((left, right) => left.time - right.time)
  for (const { file } of logs.slice(0, Math.max(0, logs.length - KEEP_LOGS))) rmSync(file, { force: true })
}

/** Resolve a command name through PATH on this platform, or return undefined. */
function which(command) {
  const extensions = WINDOWS ? (process.env.PATHEXT ?? '.COM;.EXE;.BAT;.CMD').split(';').filter(Boolean) : ['']
  const separator = WINDOWS ? ';' : ':'
  const absolute = WINDOWS ? isAbsolute(command) : command.startsWith('/')
  const directories = absolute ? [''] : (process.env.PATH ?? '').split(separator).filter(Boolean)
  for (const directory of directories) for (const extension of extensions) {
    const file = absolute ? command + extension : join(directory, command + extension)
    try { if (statSync(file).isFile()) return file } catch { /* Not here; try the next candidate. */ }
  }
  return undefined
}

/**
 * Resolve the DSH desktop executable and CLI script behind a Windows `dsh.cmd` shim.
 * Starting the shim would parent the service under cmd.exe, whose PID is not the service PID, so the launcher starts the
 * executable itself with `ELECTRON_RUN_AS_NODE` set.
 */
function windowsCommand(shim) {
  if (!existsSync(shim)) return undefined
  const text = readFileSync(shim, 'utf8')
  const executable = /"%~dp0([^"]+\.exe)"/.exec(text)?.[1]
  const script = /"%~dp0([^"]+cli\.js)"/.exec(text)?.[1]
  if (!executable || !script) return undefined
  const base = dirname(shim)
  return { executable: resolve(base, executable), script: resolve(base, script) }
}

/** Start the service for `profile`, then wait until its runtime answers. */
async function start(args) {
  const session = 'dsh-' + args.profile
  const pids = processes(args.profile)
  if (pids.length > 1) throw new Error('Multiple dsh-superagent processes found; refusing to start another.')
  if (!pids.length) {
    const log = join(ARTIFACTS, `dsh-superagent-${args.profile}-${stamp()}-${process.pid}.log`)
    mkdirSync(ARTIFACTS, { recursive: true, mode: 0o700 })
    if (WINDOWS) {
      const shim = which('dsh')
      const command = shim ? windowsCommand(shim) : undefined
      if (!command) throw new Error('dsh must be on PATH (the desktop CLI shim `dsh.cmd`), and its executable must exist.')
      if (await state(args.url) !== undefined) throw new Error('An existing orchestrator answers at this URL; refusing duplicate startup.')
      writeFileSync(log, '', { mode: 0o600 })
      pruneLogs(args.profile)
      const out = openSync(log, 'a')
      const child = spawn(command.executable, ['--expose-internals', command.script, '--profile', args.profile, '--no-open'], {
        cwd: ROOT, detached: true, windowsHide: true, stdio: ['ignore', out, out],
        env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
      })
      child.unref()
      writeFileSync(join(control(args.profile), 'service.pid'), `${child.pid}\n`, { mode: 0o600 })
      console.log('Log: ' + log)
    } else {
      const dsh = which('dsh')
      if (!dsh || !which('tmux')) throw new Error('Both dsh and tmux must be on PATH.')
      const exists = hasSession(session)
      if (await state(args.url) !== undefined) throw new Error('An existing orchestrator answers at this URL; refusing duplicate startup.')
      writeFileSync(log, '', { mode: 0o600 })
      pruneLogs(args.profile)
      // `exec` replaces the shell so the pane PID printed by tmux is the DSH service process itself.
      const command = 'umask 077; exec ' + [dsh, '--profile', args.profile, '--no-open'].map(quote).join(' ')
        + ' >> ' + quote(log) + ' 2>&1'
      // Reuse an existing tmux session without disturbing other windows.
      const target = exists ? ['new-window', '-t', '=' + session + ':'] : ['new-session', '-s', session]
      const pane = execFileSync('tmux', [...target, '-d', '-P', '-F', '#{pane_pid}', '-n', 'server', '-c', ROOT, command], { encoding: 'utf8' }).trim()
      if (/^\d+$/.test(pane)) writeFileSync(join(control(args.profile), 'service.pid'), pane + '\n', { mode: 0o600 })
      console.log('Log: ' + log)
    }
  } else {
    writeFileSync(join(control(args.profile), 'service.pid'), `${pids[0]}\n`, { mode: 0o600 })
    console.log(`dsh-superagent already running (PID ${pids[0]}); no duplicate started.`)
  }
  rmSync(join(control(args.profile), 'manually-stopped'), { force: true })
  const deadline = Date.now() + args.timeout * 1_000
  while (Date.now() < deadline) {
    const current = await state(args.url)
    if (processes(args.profile).length && runtimeUp(current)) {
      const code = await status(args)
      if (current.setup) {
        console.log('dsh-superagent is waiting for setup: ' + String(current.setup.detail ?? ''))
        console.log('Open the URL DSH printed in the log, then the dsh-superagent overview.')
      }
      if (current.feishu) {
        console.log('dsh-superagent runs without Feishu: ' + String(current.feishu.detail ?? ''))
        console.log('Fix it on the Feishu card of the Source settings.')
      }
      for (const [part, detail] of Object.entries(partErrors(current))) console.log(`${part} reports an error, which a restart does not fix: ${detail}`)
      return code
    }
    await new Promise(resolve => setTimeout(resolve, 1_000))
  }
  await status(args)
  throw new Error('Startup health check timed out; inspect the log. Any running process was left intact.')
}

/** Quote one argument for a POSIX shell. */
function quote(word) {
  return /^[A-Za-z0-9_@%+=:,./-]+$/.test(word) ? word : `'${word.replace(/'/g, `'\\''`)}'`
}

/** Return a log-name timestamp in the local time zone, matching the documented log name. */
function stamp() {
  const now = new Date()
  const two = (value) => String(value).padStart(2, '0')
  return `${now.getFullYear()}${two(now.getMonth() + 1)}${two(now.getDate())}-${two(now.getHours())}${two(now.getMinutes())}${two(now.getSeconds())}`
}

const OPTIONS = { '--profile': 'profile', '--url': 'url', '--timeout': 'timeout', '--stop-timeout': 'stopTimeout' }

/** Parse the command line (options may precede the action, as in `--respect-stop start`). */
function parse(argv) {
  const args = {
    profile: process.env.DSH_SUPERAGENT_PROFILE || 'superagent',
    url: process.env.DSH_SUPERAGENT_URL || 'http://127.0.0.1:3082',
    timeout: 60, stopTimeout: 300, respectStop: false, action: undefined,
  }
  for (let index = 0; index < argv.length; index++) {
    const word = argv[index]
    const option = OPTIONS[word]
    if (option) {
      const value = argv[++index]
      if (value === undefined) throw new Error(`${word} needs a value.`)
      args[option] = option === 'profile' || option === 'url' ? value : Number(value)
      continue
    }
    if (word === '--respect-stop') { args.respectStop = true; continue }
    if (word.startsWith('--')) throw new Error(`Unknown option: ${word}`)
    if (args.action) throw new Error(`Unexpected argument: ${word}`)
    if (!['start', 'stop', 'restart', 'status'].includes(word)) throw new Error(`Choose one of start, stop, restart, status (got ${word}).`)
    args.action = word
  }
  if (!args.action) throw new Error('Choose one of start, stop, restart, status.')
  if (!(args.timeout > 0) || !(args.stopTimeout > 0)) throw new Error('--timeout and --stop-timeout must be positive.')
  if (!/^[A-Za-z0-9_][A-Za-z0-9_.-]*$/.test(args.profile)) throw new Error('--profile must be a DSH profile name.')
  return args
}

/** Run one control operation under the profile's lock. */
async function main() {
  const args = parse(process.argv.slice(2))
  if (!WINDOWS) process.umask(0o077)
  const lock = join(control(args.profile), 'operation.lock')
  writeFileSync(lock, '', { mode: 0o600 })
  let release
  try { release = lockfile.lockSync(lock, { stale: 30_000, realpath: false }) } catch { throw new Error('Another dsh-superagent control operation is in progress.') }
  try {
    if (args.respectStop && (args.action === 'start' || args.action === 'restart') && stopped(args.profile)) {
      console.log('Intentional stop is active; automatic recovery skipped.')
      return 0
    }
    if (args.action === 'status') return await status(args)
    // Only a stop keeps automatic recovery off; a restart whose stop timed out leaves it on.
    if (args.action === 'stop' || args.action === 'restart') await stop(args, args.action === 'stop')
    if (args.action === 'start' || args.action === 'restart') return await start(args)
    return 0
  } finally { release() }
}

main().then(code => process.exit(code),
  error => { console.error(error instanceof Error ? error.message : String(error)); process.exit(1) })
