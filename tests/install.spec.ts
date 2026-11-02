import { execFile } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

const exec = promisify(execFile)
const script = join(import.meta.dirname, '..', 'scripts', 'install.mjs')
let home: string
const installer = (args: string[], env: Record<string, string> = {}) =>
  exec(process.execPath, [script, ...args], { env: { ...process.env, DSH_HOME: home, ...env }, encoding: 'utf8' })

beforeEach(() => { home = mkdtempSync(join(tmpdir(), 'install-')) })
afterEach(() => { rmSync(home, { recursive: true, force: true }) })

describe('the quickstart installer', () => {
  it('prints the steps it would take, and writes nothing, with --dry-run', async () => {
    const { stdout } = await installer(['install', '--dry-run', '--dsh', process.execPath, '--from', join(import.meta.dirname, '..')])
    expect(stdout).toContain('would check dsh')
    expect(stdout).toContain('would create profile superagent from the web template')
    expect(existsSync(join(home, 'profiles'))).toBe(false)
  })
  it('refuses a directory that is not a checkout, and an unknown command', async () => {
    await expect(installer(['install', '--from', home, '--dsh', process.execPath])).rejects.toThrow('is not a dsh-superagent checkout')
    await expect(installer(['frobnicate'])).rejects.toThrow('unknown command frobnicate')
  })
  it('reports what doctor could not find instead of changing anything', async () => {
    const result = await installer(['doctor', '--dsh', process.execPath]).catch(error => error as { stdout: string; code: number })
    const stdout = (result as { stdout: string }).stdout
    expect(stdout).toContain('FAIL profile superagent')
    expect(stdout).toContain('checks passed')
    expect((result as { code: number }).code).toBe(1)
    expect(existsSync(join(home, 'state'))).toBe(false)
  })
  it('keeps its own files inside the DSH home', async () => {
    const { stdout } = await installer(['uninstall', '--dry-run', '--dsh', process.execPath])
    expect(stdout).toContain('The profiles you work in were not touched.')
    expect(existsSync(join(home, 'profiles'))).toBe(false)
  })
})
