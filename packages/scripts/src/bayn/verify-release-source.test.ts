import { afterEach, beforeEach, expect, test } from 'bun:test'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const script = fileURLToPath(new URL('./verify-release-source.sh', import.meta.url))
let directory: string
let source: string

const git = (...args: string[]) => {
  const result = spawnSync('git', args, { cwd: directory, encoding: 'utf8' })
  if (result.status !== 0) throw new Error(result.stderr)
  return result.stdout.trim()
}

const commit = (path: string, content = 'changed') => {
  const target = join(directory, path)
  mkdirSync(dirname(target), { recursive: true })
  writeFileSync(target, content)
  git('add', path)
  git('commit', '-qm', path)
  git('update-ref', 'refs/remotes/origin/main', 'HEAD')
  return git('rev-parse', 'HEAD')
}

const verify = (candidate = source, deployedSource?: string) => {
  const args = [script, candidate]
  if (deployedSource !== undefined) {
    const manifest = join(directory, 'deployed.yaml')
    writeFileSync(manifest, `            - name: BAYN_CODE_REVISION\n              value: "${deployedSource}"\n`)
    args.push(manifest)
  }
  return spawnSync('bash', args, { cwd: directory, encoding: 'utf8' })
}

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'bayn-release-source-'))
  git('init', '-qb', 'main')
  git('config', 'user.name', 'Bayn release test')
  git('config', 'user.email', 'bayn-release@example.test')
  git('config', 'commit.gpgsign', 'false')
  git('config', 'core.hooksPath', '/dev/null')
  source = commit('services/bayn/runtime.ts', 'reviewed')
})

afterEach(() => rmSync(directory, { recursive: true, force: true }))

test('allows the exact built source and later unrelated main commits', () => {
  expect(verify(source, source).status).toBe(0)
  commit('services/keeper/runtime.rs')
  expect(verify(source, source).status).toBe(0)
})

test.each([
  '.github/PULL_REQUEST_TEMPLATE.md',
  '.github/workflows/keeper-ci.yml',
  'nix/images/keeper.nix',
  'packages/scripts/src/keeper/build.ts',
  'argocd/applications/torghut/service.yaml',
])('allows an unrelated change to %s', (path) => {
  commit(path)
  expect(verify(source, source).status).toBe(0)
})

test.each([
  'services/bayn/runtime.ts',
  'packages/scripts/src/bayn/update-manifests.ts',
  'argocd/applications/bayn/deployment.yaml',
  'argocd/applications/torghut/clickhouse/clickhouse-cluster.yaml',
  'argocd/applicationsets/product.yaml',
  'nix/images/bayn.nix',
  '.github/workflows/bayn-release.yml',
  '.github/actions/setup-nix-toolchain/action.yml',
  '.github/workflows/nix-oci-build-common.yml',
  'nix/images/bun-workspace-service.nix',
  'bun.lock',
  'services/keeper/package.json',
])('rejects a later change to %s', (path) => {
  commit(path)
  const result = verify()
  expect(result.status).toBe(1)
  expect(result.stderr).toContain('changed after this image was built')
})

test('rejects an older candidate after a newer source was deployed', () => {
  const deployed = commit('services/keeper/runtime.rs')
  const result = verify(source, deployed)
  expect(result.status).toBe(1)
  expect(result.stderr).toContain('deployed Bayn source is newer')
  expect(verify(deployed, source).status).toBe(0)
})

test('rejects sources outside main ancestry and malformed source identities', () => {
  git('checkout', '-qb', 'unmerged')
  const candidate = commit('services/keeper/runtime.rs')
  git('update-ref', 'refs/remotes/origin/main', source)
  expect(verify(candidate).status).toBe(1)
  expect(verify('--help').status).toBe(1)
  expect(verify(source, 'missing').status).toBe(1)
})
