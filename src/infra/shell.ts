/**
 * Resolves command names to executable files and chooses the shell that runs a ticket's prepare command.
 * POSIX installations and Windows installations differ in both: Windows appends `PATHEXT` extensions and has no `sh`.
 */
import { accessSync, constants, statSync } from 'node:fs'
import { isAbsolute, join } from 'node:path'

/** The extensions Windows tries for a command name that has none, in `PATHEXT` order after the bare name. */
export function extensions(platform: NodeJS.Platform = process.platform): string[] {
  if (platform !== 'win32') return ['']
  const listed = (process.env.PATHEXT ?? '.COM;.EXE;.BAT;.CMD').split(';').map(extension => extension.trim().toLowerCase()).filter(Boolean)
  return ['', ...listed]
}

/** True when `file` is an executable regular file on this platform; Windows has no execute bit for the operator to check. */
function usable(file: string, platform: NodeJS.Platform): boolean {
  try {
    if (!statSync(file).isFile()) return false
    // Windows decides whether a file runs by its extension, and `X_OK` is meaningless there.
    if (platform !== 'win32') accessSync(file, constants.X_OK)
    return true
  } catch { return false }
}

/**
 * Finds the executable a shell would run for `name` on `platform`, searching `path` left to right.
 * An absolute `name` is tried as given and then with the platform's extensions; a name containing a separator but not absolute is never a command.
 * Directories equal to `exclude` (compared through symlinks by the caller) are skipped when they appear on `path`.
 */
export function which(name: string, path: string, platform: NodeJS.Platform = process.platform, exclude?: (directory: string) => boolean): string | undefined {
  const absolute = isAbsolute(name)
  if (!absolute && /[/\\]/.test(name)) return undefined
  const directories = absolute ? [''] : path.split(platform === 'win32' ? ';' : ':').filter(directory => isAbsolute(directory) && !exclude?.(directory))
  for (const directory of directories) {
    for (const extension of extensions(platform)) {
      const candidate = absolute ? name + extension : join(directory, name + extension)
      if (usable(candidate, platform)) return candidate
    }
  }
  return undefined
}

/**
 * Builds the argv that runs `command` as a shell snippet in a ticket directory.
 * POSIX uses `sh`; Windows prefers PowerShell 7, then Windows PowerShell, then the bash installed with Git for Windows, and finally `cmd`.
 * @param platform the platform to build for, which tests set explicitly.
 * @param path the PATH to search, defaulting to the running process's.
 */
export function prepareShell(command: string, platform: NodeJS.Platform = process.platform, path = process.env.PATH ?? ''): string[] {
  if (platform !== 'win32') return ['sh', '-c', command]
  const find = (name: string): string | undefined => which(name, path, platform)
  const pwsh = find('pwsh')
  if (pwsh) return [pwsh, '-NoLogo', '-NoProfile', '-NonInteractive', '-Command', command]
  const powershell = find('powershell')
  if (powershell) return [powershell, '-NoLogo', '-NoProfile', '-NonInteractive', '-Command', command]
  const bash = find('bash')
  if (bash) return [bash, '-c', command]
  const comspec = process.env.ComSpec ?? find('cmd') ?? 'cmd.exe'
  return [comspec, '/d', '/s', '/c', command]
}
