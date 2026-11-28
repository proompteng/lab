import { afterEach, beforeEach, expect, it } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const script = fileURLToPath(new URL('../check-chart-version-bump.ts', import.meta.url))
const chart = 'charts/agents/Chart.yaml'
const template = 'charts/agents/templates/deployment.yaml'
let repo: string
let base: string

const git = (...args: string[]) => {
  const result = Bun.spawnSync(['git', '-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', ...args], {
    cwd: repo,
  })
  if (result.exitCode !== 0) throw new Error(result.stderr.toString())
  return result.stdout.toString().trim()
}

const write = (path: string, content: string) => {
  const file = join(repo, path)
  mkdirSync(dirname(file), { recursive: true })
  writeFileSync(file, content)
}

const commit = () => {
  git('add', '.')
  git('commit', '-qm', 'test fixture')
  return git('rev-parse', 'HEAD')
}

const check = (head = 'HEAD') => Bun.spawnSync([process.execPath, script, base, head], { cwd: repo })

beforeEach(() => {
  repo = mkdtempSync(join(tmpdir(), 'agents-chart-version-'))
  git('init', '-q')
  write(chart, 'version: 0.9.9\nappVersion: 0.9.0\n')
  write(template, 'kind: Deployment\n')
  base = commit()
})

afterEach(() => rmSync(repo, { recursive: true, force: true }))

it.each([template, 'charts/agents/crds/run.yaml', 'charts/agents/values.yaml'])(
  'rejects changes to %s without increasing the chart version',
  (path) => {
    write(path, 'enabled: true\n')
    write(chart, 'version: 0.9.9\nappVersion: 1.0.0\n')
    commit()
    const result = check()
    expect(result.exitCode).toBe(1)
    expect(result.stderr.toString()).toContain(`Increase ${chart} version above 0.9.9 (found 0.9.9)`)
  },
)

it('requires an increase even when a template is deleted and the version changes', () => {
  git('rm', template)
  write(chart, 'version: 0.9.8\n')
  commit()
  expect(check().exitCode).toBe(1)
})

it('accepts a semver increase in the selected commit', () => {
  write(template, 'kind: StatefulSet\n')
  write(chart, "version: '0.9.10'\n")
  const bumped = commit()
  write(chart, 'version: 0.9.9\n')
  commit()
  expect(check(bumped).exitCode).toBe(0)
})

it('does not require a chart version bump for a GitOps values change', () => {
  write('argocd/applications/agents/values.yaml', 'enabled: true\n')
  commit()
  expect(check().exitCode).toBe(0)
})
