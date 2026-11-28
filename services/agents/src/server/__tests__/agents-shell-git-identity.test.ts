import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'
import { parse } from 'yaml'

const roots: string[] = []
const entrypoint = new URL('../../../scripts/agents-shell-entrypoint.sh', import.meta.url)
const repository = new URL('../../../../../', import.meta.url)
const expectedName = 'Greg Konush'
const expectedEmail = '12027037+gregkonush@users.noreply.github.com'

const readYaml = (path: string) => parse(readFileSync(new URL(path, repository), 'utf8'))

const runBootstrap = (overrides: Record<string, string> = {}) => {
  const root = mkdtempSync(join(tmpdir(), 'agents-shell-git-identity-'))
  roots.push(root)
  const home = join(root, 'home')
  const bin = join(root, 'bin')
  mkdirSync(home)
  mkdirSync(bin)
  mkdirSync(join(root, 'scripts'))

  // Exercise the real Git bootstrap while isolating unrelated runtime startup.
  for (const command of ['mkdir', 'gh', 'bun']) {
    writeFileSync(join(bin, command), '#!/usr/bin/env bash\nexit 0\n', { mode: 0o755 })
  }
  writeFileSync(join(root, 'scripts/install-agents-shell-pstack.sh'), '#!/usr/bin/env bash\nexit 0\n', {
    mode: 0o755,
  })
  writeFileSync(join(home, '.gitconfig'), '[user]\nname = Stale Identity\nemail = stale@example.invalid\n')

  const env = {
    PATH: `${bin}:${process.env.PATH}`,
    HOME: home,
    GIT_CONFIG_GLOBAL: join(home, '.gitconfig'),
    GIT_CONFIG_NOSYSTEM: '1',
    ...overrides,
  }
  execFileSync('bash', [entrypoint.pathname], { cwd: root, env, stdio: 'pipe' })
  const git = (...args: string[]) => execFileSync('git', args, { cwd: root, env, encoding: 'utf8' }).trim()
  return { git }
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

describe('agents-shell Git identity', () => {
  it('bootstraps a GitHub-linked author and committer over stale global identity', () => {
    const { git } = runBootstrap()

    expect(git('config', '--global', 'user.name')).toBe(expectedName)
    expect(git('config', '--global', 'user.email')).toBe(expectedEmail)
    for (const role of ['GIT_AUTHOR_IDENT', 'GIT_COMMITTER_IDENT']) {
      expect(git('var', role)).toMatch(
        new RegExp(`^${expectedName} <12027037\\+gregkonush@users\\.noreply\\.github\\.com> \\d+ [+-]\\d{4}$`),
      )
    }
  })

  it('preserves explicitly configured operator identity overrides', () => {
    const { git } = runBootstrap({
      AGENTS_SHELL_GIT_USER_NAME: 'Another Operator',
      AGENTS_SHELL_GIT_USER_EMAIL: 'operator@example.invalid',
    })

    expect(git('config', '--global', 'user.name')).toBe('Another Operator')
    expect(git('config', '--global', 'user.email')).toBe('operator@example.invalid')
  })

  it('keeps chart and production defaults aligned with the native AgentRun identity', () => {
    const native = readYaml('argocd/applications/agents/codex-versioncontrolprovider.yaml').spec.defaults
    expect(native.commitAuthorName).toBe(expectedName)
    expect(native.commitAuthorEmail).toBe(expectedEmail)

    for (const path of ['charts/agents/values.yaml', 'argocd/applications/agents/values.yaml']) {
      const vars = readYaml(path).agentsShell.env.vars
      expect(vars.AGENTS_SHELL_GIT_USER_NAME).toBe(native.commitAuthorName)
      expect(vars.AGENTS_SHELL_GIT_USER_EMAIL).toBe(native.commitAuthorEmail)
    }
  })
})
