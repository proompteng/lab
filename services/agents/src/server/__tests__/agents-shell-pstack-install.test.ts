import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readlinkSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

const roots: string[] = []
const installer = new URL('../../../scripts/install-agents-shell-pstack.sh', import.meta.url)

const makeFixture = () => {
  const root = mkdtempSync(join(tmpdir(), 'agents-shell-pstack-'))
  roots.push(root)
  const home = join(root, 'home')
  const pstack = join(root, 'pstack')
  const skills = join(pstack, 'skills')
  const prompts = join(pstack, '.codex-plugin', 'prompts')

  mkdirSync(join(skills, 'poteto-mode'), { recursive: true })
  mkdirSync(join(skills, 'tdd'), { recursive: true })
  mkdirSync(prompts, { recursive: true })
  writeFileSync(join(skills, 'poteto-mode', 'SKILL.md'), '# poteto mode\n')
  writeFileSync(join(skills, 'tdd', 'SKILL.md'), '# tdd\n')
  writeFileSync(join(prompts, 'poteto-mode.md'), 'use poteto-mode\n')
  writeFileSync(join(prompts, 'tdd.md'), 'use tdd\n')

  return { home, pstack, skills, prompts }
}

const runInstaller = (home: string, pstack: string) =>
  execFileSync('bash', [installer.pathname], {
    env: { ...process.env, HOME: home, AGENTS_SHELL_PSTACK_ROOT: pstack },
    stdio: 'pipe',
  })

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

describe('agents-shell pstack installer', () => {
  it('installs Poteto skills and Codex prompt shortcuts without network access', () => {
    const fixture = makeFixture()

    runInstaller(fixture.home, fixture.pstack)

    expect(readlinkSync(join(fixture.home, '.agents', 'skills', 'poteto-mode'))).toBe(
      join(fixture.skills, 'poteto-mode'),
    )
    expect(readlinkSync(join(fixture.home, '.agents', 'skills', 'tdd'))).toBe(join(fixture.skills, 'tdd'))
    expect(readlinkSync(join(fixture.home, '.codex', 'prompts', 'poteto-mode.md'))).toBe(
      join(fixture.prompts, 'poteto-mode.md'),
    )
  })

  it('is idempotent and preserves user-managed collisions', () => {
    const fixture = makeFixture()
    const userSkill = join(fixture.home, 'custom-poteto-mode')
    const removedSkill = join(fixture.pstack, 'skills', 'removed-skill')
    const removedPrompt = join(fixture.pstack, '.codex-plugin', 'prompts', 'removed.md')
    mkdirSync(userSkill, { recursive: true })
    mkdirSync(join(fixture.home, '.agents', 'skills'), { recursive: true })
    mkdirSync(join(fixture.home, '.codex', 'prompts'), { recursive: true })
    symlinkSync(userSkill, join(fixture.home, '.agents', 'skills', 'poteto-mode'))
    symlinkSync(removedSkill, join(fixture.home, '.agents', 'skills', 'removed-skill'))
    symlinkSync(removedPrompt, join(fixture.home, '.codex', 'prompts', 'removed.md'))

    runInstaller(fixture.home, fixture.pstack)
    runInstaller(fixture.home, fixture.pstack)

    expect(readlinkSync(join(fixture.home, '.agents', 'skills', 'poteto-mode'))).toBe(userSkill)
    expect(readlinkSync(join(fixture.home, '.agents', 'skills', 'tdd'))).toBe(join(fixture.skills, 'tdd'))
    expect(() => readlinkSync(join(fixture.home, '.agents', 'skills', 'removed-skill'))).toThrow()
    expect(() => readlinkSync(join(fixture.home, '.codex', 'prompts', 'removed.md'))).toThrow()
  })
})
