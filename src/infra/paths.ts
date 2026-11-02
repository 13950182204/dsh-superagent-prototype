/** Resolves packaged asset paths from either the source tree or the compiled lib/ output, and normalizes paths for PATH and git comparisons. */
import { existsSync, readFileSync, realpathSync } from 'node:fs'
import { delimiter, dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

let cached: string | undefined
export function packageRoot(): string {
  if (cached) return cached
  let directory = dirname(fileURLToPath(import.meta.url))
  for (let depth = 0; depth < 6; depth++) {
    const manifest = join(directory, 'package.json')
    if (existsSync(manifest)) {
      try { if ((JSON.parse(readFileSync(manifest, 'utf8')) as { name?: string }).name === 'dsh-superagent') return cached = directory }
      catch { /* A foreign package.json on the way up is not this package. */ }
    }
    directory = dirname(directory)
  }
  throw new Error('dsh-superagent package root not found')
}
export const packagePath = (...parts: string[]): string => join(packageRoot(), ...parts)

/** Compares two directories by their real paths, so a symlink and its target count as the same directory; a missing path compares as itself. */
export function sameDirectory(a: string, b: string): boolean {
  const real = (path: string): string => { try { return realpathSync(path) } catch { return resolve(path) } }
  return real(a) === real(b)
}

/** Removes `dir` from a PATH value, comparing entries through symlinks so a normalized spelling of the same directory is removed too. */
export function withoutDirectory(path: string, dir: string): string {
  return path.split(delimiter).filter(entry => !sameDirectory(entry, dir)).join(delimiter)
}

/**
 * Normalizes a native path to the forward-slash form git reports and reads in its configuration files.
 * Windows paths keep their drive letter and share prefix, which git accepts with either separator.
 */
export function gitPath(path: string): string {
  return process.platform === 'win32' ? path.replaceAll('\\', '/') : path
}
