import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { installBundledSkill, listBundledSkills, resolveBundledSkillsDirectory } from '../../src/skills'

const tempDirectories: string[] = []

afterEach(async () => {
  while (tempDirectories.length > 0) {
    const directory = tempDirectories.pop()
    if (directory) {
      await rm(directory, { recursive: true, force: true })
    }
  }
})

describe('bundled skills', () => {
  test('lists temporal skill from bundled manifest', async () => {
    const skills = await listBundledSkills()
    expect(skills.some((skill) => skill.name === 'temporal')).toBeTrue()

    const skillsRoot = resolveBundledSkillsDirectory()
    expect(skillsRoot.endsWith('/skills')).toBeTrue()
  })

  test('installs bundled skill and enforces overwrite opt-in', async () => {
    const installRoot = await mkdtemp(join(tmpdir(), 'temporal-bun-skill-'))
    tempDirectories.push(installRoot)

    const firstInstall = await installBundledSkill({
      skillName: 'temporal',
      destinationDir: installRoot,
    })

    const skillDocument = await readFile(join(firstInstall.installedPath, 'SKILL.md'), 'utf8')
    expect(skillDocument).toContain('name: temporal')

    await expect(
      installBundledSkill({
        skillName: 'temporal',
        destinationDir: installRoot,
      }),
    ).rejects.toThrow('Skill destination already exists')

    const overwriteInstall = await installBundledSkill({
      skillName: 'temporal',
      destinationDir: installRoot,
      force: true,
    })

    expect(overwriteInstall.overwritten).toBeTrue()
  })
})
