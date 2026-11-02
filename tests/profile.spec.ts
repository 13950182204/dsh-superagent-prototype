import { describe, expect, it } from 'vitest'
import { profileName, sharedProfile } from '../src/infra/profile.ts'

describe('DSH profile detection', () => {
  it('reads the profile from the command line, either spelling, before the environment', () => {
    expect(profileName(['node', 'dsh', '--profile', 'superagent'], {})).toBe('superagent')
    expect(profileName(['node', 'dsh', '--profile=superagent'], {})).toBe('superagent')
    expect(profileName(['node', 'dsh', '--profile', 'superagent'], { DSH_PROFILE: 'desktop' })).toBe('superagent')
    expect(profileName(['node', 'dsh'], { DSH_PROFILE: 'superagent' })).toBe('superagent')
    expect(profileName(['node', 'dsh'], {})).toBeUndefined()
  })
  it('treats the operator profiles, and a process that names none, as shared', () => {
    expect(sharedProfile(undefined)).toBe(true)
    expect(sharedProfile('desktop')).toBe(true)
    expect(sharedProfile('web')).toBe(true)
    expect(sharedProfile('superagent')).toBe(false)
  })
})
