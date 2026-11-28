import {
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { installPstackSkills } from './pstack'

describe('installPstackSkills', () => {
  let root: string
  let bundleSkillsPath: string
  let codexHome: string
  let codexSkillsPath: string

  const addSkill = (name: string) => {
    const path = join(bundleSkillsPath, name)
    mkdirSync(path, { recursive: true })
    writeFileSync(join(path, 'SKILL.md'), `# ${name}\n`)
    return path
  }

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'agents-runner-pstack-'))
    bundleSkillsPath = join(root, 'image bundle', 'skills')
    codexHome = join(root, 'mounted codex home')
    codexSkillsPath = join(codexHome, 'skills')
  })

  afterEach(() => {
    rmSync(root, { recursive: true, force: true })
  })

  it('links only skill directories into an empty mounted home by default, without requiring prompts', () => {
    mkdirSync(codexHome)
    const poteto = addSkill('poteto-mode')
    const unslop = addSkill('unslop')
    mkdirSync(join(bundleSkillsPath, 'not-a-skill'))
    writeFileSync(join(bundleSkillsPath, 'README.md'), 'Not a skill')

    installPstackSkills({ codexHome, bundleSkillsPath })

    expect(readdirSync(codexHome)).toEqual(['skills'])
    expect(readdirSync(codexSkillsPath).sort()).toEqual(['poteto-mode', 'unslop'])
    expect(readlinkSync(join(codexSkillsPath, 'poteto-mode'))).toBe(poteto)
    expect(readlinkSync(join(codexSkillsPath, 'unslop'))).toBe(unslop)
    expect(readFileSync(join(codexSkillsPath, 'unslop', 'SKILL.md'), 'utf8')).toBe('# unslop\n')
  })

  it('can be run again with the same home without replacing correct links', () => {
    const source = addSkill('poteto-mode')
    const path = join(codexSkillsPath, 'poteto-mode')
    installPstackSkills({ codexHome, bundleSkillsPath, enabled: 'true' })
    const linkInode = lstatSync(path).ino

    installPstackSkills({ codexHome, bundleSkillsPath, enabled: 'true' })

    expect(lstatSync(path).ino).toBe(linkInode)
    expect(readlinkSync(path)).toBe(source)
  })

  it('preserves local files, directories and stale links while installing missing skills', () => {
    for (const name of ['file', 'directory', 'external', 'stale', 'unslop']) addSkill(name)
    mkdirSync(join(codexSkillsPath, 'directory'), { recursive: true })
    writeFileSync(join(codexSkillsPath, 'file'), 'local file')
    writeFileSync(join(codexSkillsPath, 'directory', 'SKILL.md'), 'local skill')
    const external = join(root, 'external-skill')
    const stale = join(bundleSkillsPath, 'removed-skill')
    mkdirSync(external)
    symlinkSync(external, join(codexSkillsPath, 'external'))
    symlinkSync(stale, join(codexSkillsPath, 'stale'))

    installPstackSkills({ codexHome, bundleSkillsPath })

    expect(readFileSync(join(codexSkillsPath, 'file'), 'utf8')).toBe('local file')
    expect(readFileSync(join(codexSkillsPath, 'directory', 'SKILL.md'), 'utf8')).toBe('local skill')
    expect(readlinkSync(join(codexSkillsPath, 'external'))).toBe(external)
    expect(readlinkSync(join(codexSkillsPath, 'stale'))).toBe(stale)
    expect(readlinkSync(join(codexSkillsPath, 'unslop'))).toBe(join(bundleSkillsPath, 'unslop'))
  })

  it('does not change the home when explicitly disabled, even with a bundle present', () => {
    addSkill('poteto-mode')

    installPstackSkills({ codexHome, bundleSkillsPath, enabled: 'false' })

    expect(lstatSync(codexHome, { throwIfNoEntry: false })).toBeUndefined()
  })

  it('does not change the home if an optional bundle is absent', () => {
    installPstackSkills({ codexHome, bundleSkillsPath })

    expect(lstatSync(codexHome, { throwIfNoEntry: false })).toBeUndefined()
  })

  it('fails with the bundle path and enablement setting when a required bundle is absent', () => {
    expect(() => installPstackSkills({ codexHome, bundleSkillsPath, enabled: 'true' })).toThrow(
      `AGENTS_RUNNER_PSTACK_ENABLED=true requires pstack skills at ${bundleSkillsPath}`,
    )
    expect(lstatSync(codexHome, { throwIfNoEntry: false })).toBeUndefined()
  })

  it('rejects a present bundle with no installable skills', () => {
    mkdirSync(join(bundleSkillsPath, 'incomplete'), { recursive: true })

    expect(() => installPstackSkills({ codexHome, bundleSkillsPath })).toThrow('contains no skills with SKILL.md')
    expect(lstatSync(codexHome, { throwIfNoEntry: false })).toBeUndefined()
  })

  it('rejects an invalid enablement value', () => {
    expect(() => installPstackSkills({ codexHome, bundleSkillsPath, enabled: 'maybe' })).toThrow(
      'AGENTS_RUNNER_PSTACK_ENABLED must be true or false',
    )
  })

  it('surfaces real filesystem errors rather than treating them as missing optional bundles', () => {
    mkdirSync(join(bundleSkillsPath, '..'), { recursive: true })
    writeFileSync(bundleSkillsPath, 'not a directory')

    expect(() => installPstackSkills({ codexHome, bundleSkillsPath })).toThrow('ENOTDIR')
  })
})
