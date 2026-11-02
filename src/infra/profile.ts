/** Which DSH profile this process serves, and whether that profile is safe to run dsh-superagent in. */
import { basename } from 'node:path'

/** Profiles DSH ships for the operator's own work; dsh-superagent must not change their environment. */
const OPERATOR_PROFILES = ['desktop', 'web']

/** Reads the profile DSH selected: `--profile <name>` on the command line, or the environment a bundled runtime sets. */
export function profileName(argv: readonly string[] = process.argv, env: NodeJS.ProcessEnv = process.env): string | undefined {
  const flag = argv.findIndex(argument => argument === '--profile')
  if (flag >= 0 && argv[flag + 1]) return argv[flag + 1]
  const assigned = argv.find(argument => argument.startsWith('--profile='))
  if (assigned) return assigned.slice('--profile='.length)
  return env.DSH_PROFILE || undefined
}

/**
 * Whether dsh-superagent must not run as a service in `name`: an operator profile, or a process that does not name its
 * profile at all. A dedicated profile — the one the quickstart installer writes — is the only place where the plugin may
 * change this process's environment, since worker Sessions inherit it.
 */
export function sharedProfile(name: string | undefined): boolean {
  return name === undefined || OPERATOR_PROFILES.includes(basename(name))
}
