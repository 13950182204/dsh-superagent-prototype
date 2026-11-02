#!/usr/bin/env node
/**
 * Installs dsh-superagent as a DSH profile of its own, without touching the profiles the operator works in.
 *
 * `install` creates the profile, writes the plugin configuration into it, builds this checkout and links it as a plugin.
 * `doctor` re-checks an installation, and `uninstall` removes what install wrote. Every write stays inside $DSH_HOME.
 */
import { execFileSync, spawnSync } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const PACKAGE = JSON.parse(readFileSync(join(HERE, '..', 'package.json'), 'utf8'))
const NAME = PACKAGE.name
const DSH_HOME = process.env.DSH_HOME || join(homedir(), '.dsh')
const PLUGIN_DIR = join(DSH_HOME, 'plugins', NAME)
const isWindows = process.platform === 'win32'

const USAGE = `usage: node scripts/install.mjs <install|doctor|uninstall> [options]

  --profile <name>     DSH profile to create or inspect (default superagent)
  --from <url|dir>     checkout to install: a git URL cloned into $DSH_HOME/plugins, or a directory (default: this checkout)
  --port <port>        port of the management panel (default 3082; DSH itself usually serves 53xxx)
  --state-dir <dir>    state directory (default $DSH_HOME/state/<profile>)
  --dsh <path>         the dsh command to run (default: dsh on PATH)
  --dry-run            print every step without writing or running anything that changes state
  --force              reconfigure an existing profile, keeping a .bak copy of its patch file
  --keep-state         uninstall: keep the state directory
  --purge-profile      uninstall: delete the profile directory as well`

/** Quotes a value for a YAML scalar. */
const yaml = (value) => `'${String(value).replaceAll("'", "''")}'`
const log = (message, ...rest) => console.log(message, ...rest)
const fail = (message) => { throw new Error(message) }

function parse(argv) {
  const options = { command: 'install', profile: 'superagent', from: '', port: 3082, stateDir: '', dsh: '', dryRun: false,
    force: false, keepState: false, purgeProfile: false, tools: false }
  const flags = { '--dry-run': 'dryRun', '--force': 'force', '--keep-state': 'keepState', '--purge-profile': 'purgeProfile', '--tools': 'tools' }
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index]
    if (argument === '-h' || argument === '--help') { log(USAGE); process.exit(0) }
    if (argument in flags) { options[flags[argument]] = true; continue }
    if (!argument.startsWith('--')) { options.command = argument; continue }
    const value = argv[++index]
    if (value === undefined) fail(`${argument} needs a value\n\n${USAGE}`)
    if (argument === '--profile') options.profile = value
    else if (argument === '--from') options.from = value
    else if (argument === '--port') options.port = Number(value)
    else if (argument === '--state-dir') options.stateDir = value
    else if (argument === '--dsh') options.dsh = value
    else fail(`unknown option ${argument}\n\n${USAGE}`)
  }
  if (!['install', 'doctor', 'uninstall'].includes(options.command)) fail(`unknown command ${options.command}\n\n${USAGE}`)
  if (!/^[A-Za-z0-9_][A-Za-z0-9_.-]*$/.test(options.profile)) fail(`invalid profile name ${options.profile}`)
  if (!Number.isInteger(options.port) || options.port < 1 || options.port > 65535) fail(`invalid port ${options.port}`)
  options.stateDir ||= join(DSH_HOME, 'state', options.profile)
  if (!isAbsolute(options.stateDir)) fail(`--state-dir must be absolute: ${options.stateDir}`)
  return options
}

/** Runs a program and returns its output; with `quiet` the child's output is captured instead of shown. */
function run(program, args, { cwd, quiet = false, env = process.env } = {}) {
  if (quiet) return execFileSync(program, args, { cwd, env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
  const result = spawnSync(program, args, { cwd, env, stdio: 'inherit' })
  if (result.error) fail(`${program} could not run: ${result.error.message}`)
  if (result.status !== 0) fail(`${[program, ...args].join(' ')} exited with ${result.status}`)
  return ''
}

/** Finds a program on PATH, honouring PATHEXT on Windows. */
function which(name) {
  const path = process.env.PATH || ''
  const extensions = isWindows ? ['', ...(process.env.PATHEXT || '.COM;.EXE;.BAT;.CMD').split(';')] : ['']
  for (const directory of path.split(isWindows ? ';' : ':')) {
    if (!directory) continue
    for (const extension of extensions) {
      const file = join(directory, name + extension)
      try { if (statSync(file).isFile()) return file } catch { /* not here */ }
    }
  }
  return undefined
}

/** The dsh command: the option first, then PATH, so a desktop install's shim works. */
function dshCommand(options) {
  if (options.dsh) return options.dsh
  return which('dsh') ?? fail('dsh was not found on PATH; pass --dsh <path to the dsh command>')
}

/** pnpm to build the checkout: the environment, PATH, then the copy DSH ships beside its runtime. */
function pnpmCommand(dsh) {
  if (process.env.DSH_PNPM) return [process.execPath, [process.env.DSH_PNPM]]
  const found = which('pnpm') ?? which('pnpm.cjs')
  if (found) return [found, []]
  const guess = join(dirname(dsh), '..', 'runtime')
  for (const root of [guess, join(dirname(dsh), 'resources', 'runtime')]) {
    try {
      const runtime = readdirSync(root).map(name => join(root, name, 'dependencies', 'pnpm', 'bin', 'pnpm.cjs')).find(existsSync)
      if (runtime) return [process.execPath, [runtime]]
    } catch { /* not this layout */ }
  }
  return undefined
}

/** Copies a file that may not exist yet; used for backups. */
function backup(file) {
  if (existsSync(file)) { renameSync(file, `${file}.bak`); log(`  kept ${file}.bak`) }
}

const patchFile = (options) => join(DSH_HOME, 'profiles', options.profile, 'cordis.patch.yml')
const patchText = (options) => `# Written by dsh-superagent's installer; remove the plugin ids below to stop loading it.
- id: webserver
  config:
    host: 127.0.0.1
    port: ${options.port}
- id: dsh-superagent
  config:
    stateDir: ${yaml(options.stateDir)}
    allowSharedProfile: false
# Feishu is optional: uncomment to enable its Source, then set the bot's lark-cli on the Feishu Source.
# - id: dsh-superagent-feishu
#   disabled: false
`

const step = (options, message) => log(options.dryRun ? `would ${message}` : message)

function checkout(options) {
  if (options.from && /^(?:https?|git|ssh):/.test(options.from)) {
    if (existsSync(PLUGIN_DIR)) fail(`${PLUGIN_DIR} already exists; remove it, or pass --from a directory`)
    step(options, `clone ${options.from} into ${PLUGIN_DIR}`)
    if (!options.dryRun) { mkdirSync(dirname(PLUGIN_DIR), { recursive: true }); run('git', ['clone', '--depth', '1', options.from, PLUGIN_DIR]) }
    return PLUGIN_DIR
  }
  const directory = resolve(options.from || join(HERE, '..'))
  if (!existsSync(join(directory, 'package.json'))) fail(`${directory} is not a dsh-superagent checkout`)
  return directory
}

function build(options, directory) {
  if (existsSync(join(directory, 'lib', 'index.js')) && !options.force) { log(`  ${directory}/lib is already built`); return }
  const dsh = dshCommand(options)
  const pnpm = pnpmCommand(dsh) ?? fail('pnpm was not found; install it, or set DSH_PNPM to its pnpm.cjs')
  step(options, `install ${directory}`)
  if (!options.dryRun) run(pnpm[0], [...pnpm[1], 'install', '--config.confirmModulesPurge=false'], { cwd: directory })
  step(options, `build ${directory}`)
  if (!options.dryRun) run(pnpm[0], [...pnpm[1], 'run', 'build'], { cwd: directory })
  if (!options.dryRun && !existsSync(join(directory, 'lib', 'index.js'))) fail('the build produced no lib/index.js')
}

function install(options) {
  log(`dsh-superagent ${PACKAGE.version} into profile ${options.profile} (${DSH_HOME})`)
  const dsh = dshCommand(options)
  const profile = join(DSH_HOME, 'profiles', options.profile)
  const patch = patchFile(options)
  step(options, `check dsh: ${dsh}`)
  if (!options.dryRun) run(dsh, ['--version'], { quiet: true })
  const directory = checkout(options)
  build(options, directory)
  if (existsSync(profile) && !options.force) fail(`profile ${options.profile} already exists; pass --force to reconfigure it (its patch file is kept as .bak)`)
  step(options, `create profile ${options.profile} from the web template`)
  if (!options.dryRun) {
    mkdirSync(join(DSH_HOME, 'profiles'), { recursive: true })
    if (existsSync(patch)) backup(patch)
    run(dsh, [options.profile, '--from-default-profile', 'web', '--dump-config'], { quiet: true })
    writeFileSync(patch, patchText(options))
    step(options, `link ${directory} as a plugin of profile ${options.profile}`)
    run(dsh, ['plugin', '--profile', options.profile, 'add', `link:${directory}`])
    const bin = join(DSH_HOME, 'bin')
    mkdirSync(bin, { recursive: true })
    const launcher = join(directory, 'scripts', 'dsh-superagent.mjs')
    if (isWindows) writeFileSync(join(bin, 'dsh-superagent.cmd'), `@echo off\r\n"${process.execPath}" "${launcher}" %*\r\n`)
    else { const file = join(bin, 'dsh-superagent'); writeFileSync(file, `#!/bin/sh\nexec "${process.execPath}" "${launcher}" "$@"\n`); chmodSync(file, 0o755) }
    log(`\ninstalled. Next:\n  1. ${join(bin, isWindows ? 'dsh-superagent.cmd' : 'dsh-superagent')} start\n  2. open http://127.0.0.1:${options.port}/ and fill in the Sources\n  3. ${join(bin, isWindows ? 'dsh-superagent.cmd' : 'dsh-superagent')} status`)
  }
}

function doctor(options) {
  const checks = []
  const check = (name, ok, detail = '') => { checks.push({ name, ok, detail }); log(`${ok ? 'ok  ' : 'FAIL'} ${name}${detail ? `: ${detail}` : ''}`) }
  const dsh = dshCommand(options)
  let version = ''
  try { version = run(dsh, ['--version'], { quiet: true }).trim() } catch (error) { version = String(error.message ?? error) }
  check('dsh', /0\.2\.1/.test(version), version || 'dsh did not report a version')
  check('node', Number(process.versions.node.split('.')[0]) >= 22, process.versions.node)
  const profile = join(DSH_HOME, 'profiles', options.profile)
  check(`profile ${options.profile}`, existsSync(profile), profile)
  const patch = existsSync(patchFile(options)) ? readFileSync(patchFile(options), 'utf8') : ''
  check('plugin entry', patch.includes(`- id: ${NAME}`), patchFile(options))
  check('state directory', existsSync(options.stateDir), options.stateDir)
  const packageFile = join(profile, 'package.json')
  const linked = existsSync(packageFile) && readFileSync(packageFile, 'utf8').includes(NAME)
  check('plugin installed', linked, packageFile)
  const built = existsSync(join(PLUGIN_DIR, 'lib', 'index.js')) || existsSync(join(HERE, '..', 'lib', 'index.js'))
  check('built lib', built)
  const launcher = join(DSH_HOME, 'bin', isWindows ? 'dsh-superagent.cmd' : 'dsh-superagent')
  check('service command', existsSync(launcher), launcher)
  check('git', Boolean(which('git')), which('git') || '')
  check('glab', Boolean(which('glab')), 'needed by the GitLab Source')
  check('gh', Boolean(which('gh')), 'needed by the GitHub Source')
  const failed = checks.filter(entry => !entry.ok)
  log(`\n${checks.length - failed.length}/${checks.length} checks passed`)
  process.exit(failed.length ? 1 : 0)
}

function uninstall(options) {
  const patch = patchFile(options)
  log(`removing dsh-superagent from profile ${options.profile}`)
  if (existsSync(patch)) { step(options, `delete ${patch}`); if (!options.dryRun) backup(patch) }
  const dsh = dshCommand(options)
  step(options, `remove the plugin from profile ${options.profile}`)
  if (!options.dryRun) { try { run(dsh, ['plugin', '--profile', options.profile, 'remove', NAME], { quiet: true }) } catch (error) { log(`  ${error.message}`) } }
  const shim = join(DSH_HOME, 'bin', isWindows ? 'dsh-superagent.cmd' : 'dsh-superagent')
  if (existsSync(shim)) { step(options, `delete ${shim}`); if (!options.dryRun) rmSync(shim) }
  if (options.keepState) log(`  kept ${options.stateDir}`)
  else if (existsSync(options.stateDir)) { step(options, `delete ${options.stateDir}`); if (!options.dryRun) rmSync(options.stateDir, { recursive: true, force: true }) }
  if (options.purgeProfile && existsSync(join(DSH_HOME, 'profiles', options.profile))) {
    step(options, `delete profile ${options.profile}`); if (!options.dryRun) rmSync(join(DSH_HOME, 'profiles', options.profile), { recursive: true, force: true })
  }
  log('done. The profiles you work in were not touched.')
}

const options = parse(process.argv.slice(2))
try {
  if (options.command === 'install') install(options)
  else if (options.command === 'doctor') doctor(options)
  else uninstall(options)
} catch (error) {
  console.error(`dsh-superagent installer: ${error.message}`)
  process.exit(1)
}
