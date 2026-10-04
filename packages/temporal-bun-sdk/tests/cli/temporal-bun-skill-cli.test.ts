import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { runSkillCli } from '../../src/skills/cli'

const tempDirectories: string[] = []

afterEach(async () => {
  while (tempDirectories.length > 0) {
    const directory = tempDirectories.pop()
    if (directory) {
      await rm(directory, { recursive: true, force: true })
    }
  }
})

describe('temporal-bun skill CLI', () => {
  test('list prints bundled skills', async () => {
    const logs: string[] = []
    const errors: string[] = []

    const result = await runSkillCli(['list'], {}, { log: (message) => logs.push(message), error: (message) => errors.push(message) })

    expect(result).toBeUndefined()
    expect(errors).toHaveLength(0)
    expect(logs.some((line) => line.startsWith('temporal\t'))).toBeTrue()
  })

  test('install installs bundled temporal skill to explicit directory', async () => {
    const installRoot = await mkdtemp(join(tmpdir(), 'temporal-bun-skill-cli-'))
    tempDirectories.push(installRoot)

    const logs: string[] = []
    const errors: string[] = []

    const result = await runSkillCli(
      ['install', 'temporal'],
      { to: installRoot },
      { log: (message) => logs.push(message), error: (message) => errors.push(message) },
    )

    expect(result).toBeUndefined()
    expect(errors).toHaveLength(0)
    expect(logs.some((line) => line.includes('Installed temporal to'))).toBeTrue()
  })
})
