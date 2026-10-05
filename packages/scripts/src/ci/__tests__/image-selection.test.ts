import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { expect, test } from 'bun:test'
import YAML from 'yaml'

import { loadImpactMap, matchesGlob, selectImpactPlan } from '../impact-router'

const repoRoot = new URL('../../../../../', import.meta.url)
const readRepoFile = (path: string): string => readFileSync(new URL(path, repoRoot), 'utf8')
const workflow = (name: string) => YAML.parse(readRepoFile(`.github/workflows/${name}.yml`))
const selected = (name: string, event: string, files: string[]): boolean => {
  const paths = workflow(name).on[event]?.paths as string[] | undefined
  return (
    paths !== undefined &&
    files.some((file) =>
      paths.reduce((match, path) => {
        const excluded = path.startsWith('!')
        return matchesGlob(file, excluded ? path.slice(1) : path) ? !excluded : match
      }, false),
    )
  )
}

// The exact changed-file set from Agents Shell PR #14776. Its shared workflow edit
// must still validate shared consumers; future service-only checks use the caller hook.
const shellReapingFiles = [
  '.github/ci/impact-map.yml',
  '.github/workflows/agents-build-push.yml',
  '.github/workflows/agents-ci.yml',
  '.github/workflows/nix-oci-build-common.yml',
  'argocd/applications/kargo/warehouses.yaml',
  'docs/agents/agents-shell-activity.md',
  'nix/images/agents.nix',
  'nix/verify-agents-shell-image-lifecycle.sh',
  'packages/scripts/src/agents/__tests__/resolve-agents-image-mode.test.ts',
  'packages/scripts/src/agents/resolve-agents-image-mode.ts',
  'packages/scripts/src/shared/__tests__/kargo.test.ts',
  'services/agents/scripts/agents-shell-entrypoint.sh',
  'services/agents/src/server/agents-shell/constants.ts',
  'services/agents/src/server/agents-shell/errors.ts',
  'services/agents/src/server/agents-shell/execution.test.ts',
  'services/agents/src/server/agents-shell/http-lifecycle.test.ts',
  'services/agents/src/server/agents-shell/http.ts',
  'services/agents/src/server/agents-shell/process-runner.test.ts',
  'services/agents/src/server/agents-shell/runner.ts',
]

test.each(['rune-images', 'restate-images', 'temporal-worker-images'])(
  '%s ignores the unrelated Shell reaping change on PR and main',
  (name) => {
    for (const event of ['pull_request', 'push']) {
      expect(selected(name, event, shellReapingFiles)).toBe(false)
    }
  },
)

test.each([
  ['rune-images', 'rune', 'rune'],
  ['restate-images', 'restate', 'restate'],
  ['temporal-worker-images', 'temporal-worker', 'temporal'],
  ['bayn-build-push', 'bayn', 'bayn'],
])('%s retains its own source, workflow and deployment inputs', (name, service, app) => {
  for (const path of [
    `services/${service}/Dockerfile`,
    `.github/workflows/${name}.yml`,
    `argocd/applications/${app}/deployment.yaml`,
  ]) {
    expect(selected(name, 'push', [path])).toBe(true)
  }
  for (const path of [
    'argocd/applications/kargo/warehouses.yaml',
    'argocd/applications/kargo/stages.yaml',
    'argocd/applicationsets/platform.yaml',
    'argocd/applicationsets/product.yaml',
    'packages/scripts/src/shared/__tests__/kargo.test.ts',
  ]) {
    expect(selected(name, 'push', [path])).toBe(false)
  }
})

test('Shell-owned verification changes leave Headlamp idle; shared build changes still select it', () => {
  expect(selected('headlamp-ci', 'pull_request', shellReapingFiles)).toBe(true)
  const shellOnlyFiles = shellReapingFiles.filter((path) => path !== '.github/workflows/nix-oci-build-common.yml')
  for (const event of ['pull_request', 'push']) {
    expect(selected('headlamp-ci', event, shellOnlyFiles)).toBe(false)
    for (const path of [
      '.github/workflows/nix-oci-build-common.yml',
      'nix/oci-push.sh',
      'packages/scripts/src/shared/oci.ts',
    ]) {
      expect(selected('headlamp-ci', event, [path])).toBe(true)
    }
  }
  expect(selected('agents-build-push', 'push', ['.github/workflows/agents-build-push.yml'])).toBe(true)
  expect(selected('agents-build-push', 'push', ['nix/verify-agents-shell-image-lifecycle.sh'])).toBe(true)
})

test('Kargo-only changes retain contract, schema and workflow validation', () => {
  const files = ['argocd/applications/kargo/warehouses.yaml', 'argocd/applicationsets/platform.yaml']
  expect(selected('scripts-ci', 'pull_request', files)).toBe(true)
  const map = loadImpactMap(new URL('.github/ci/impact-map.yml', repoRoot).pathname)
  expect(selectImpactPlan(files, map).validationTargets).toEqual(expect.arrayContaining(['argo-lint', 'kubeconform']))
  expect(selectImpactPlan(['.github/workflows/rune-images.yml'], map).validationTargets).toContain('workflow-lint')
})

test('actual shared workspace dependency inputs remain selected', () => {
  for (const name of ['froussard-ci', 'bayn-build-push']) {
    for (const path of [
      'bun.lock',
      'services/bayn/package.json',
      'nix/images/bun-workspace-deps-source.nix',
      'nix/images/bun-workspace-service.nix',
    ]) {
      expect(selected(name, 'push', [path])).toBe(true)
    }
  }
  expect(selected('restate-images', 'push', ['packages/scripts/src/shared/docker.ts'])).toBe(true)
})

const verifierStep = () =>
  workflow('nix-oci-build-common').jobs['build-platform'].steps.find(
    (step: { name?: string }) => step.name === 'Verify service image contract',
  )

test('each existing image verifier is caller-owned and gates platform publication', () => {
  const common = workflow('nix-oci-build-common')
  expect(common.on.workflow_call.inputs.verify_image_script).toEqual({ required: false, type: 'string', default: '' })
  const steps = common.jobs['build-platform'].steps as { name: string }[]
  const index = steps.findIndex((step) => step.name === 'Verify service image contract')
  expect(index).toBeGreaterThan(steps.findIndex((step) => step.name === 'Inspect Nix image archive'))
  expect(index).toBeLessThan(steps.findIndex((step) => step.name === 'Push platform image without Docker'))
  expect(verifierStep().if).toBe("inputs.verify_image_script != ''")
  for (const [name, job, script] of [
    ['agents-build-push', 'agents-shell-image', 'nix/verify-agents-shell-image-lifecycle.sh'],
    ['bayn-ci', 'image', 'nix/verify-bayn-image-command.sh'],
    ['bayn-build-push', 'image', 'nix/verify-bayn-image-command.sh'],
    ['headlamp-ci', 'nix-image-pr', 'nix/verify-headlamp-image-assets.sh'],
    ['headlamp-ci', 'nix-image', 'nix/verify-headlamp-image-assets.sh'],
  ]) {
    expect(workflow(name).jobs[job].with.verify_image_script).toBe(script)
  }
})

test('image verification safely passes one archive argument and propagates failure', () => {
  const step = verifierStep()
  expect(step).toBeDefined()
  const root = mkdtempSync(join(tmpdir(), 'image-verifier-'))
  try {
    mkdirSync(join(root, 'nix'))
    writeFileSync(join(root, 'nix/ci-run-timed.sh'), '#!/bin/bash\nset -euo pipefail\nshift 2\n"$@"\n')
    const script = 'nix/verify-agents-shell-image-lifecycle.sh'
    writeFileSync(
      join(root, script),
      '#!/bin/bash\nset -euo pipefail\ntest "$#" = 1\nprintf "%s" "$1" > verified\nexit "${VERIFY_EXIT:-0}"\n',
    )
    const env = {
      ...process.env,
      IMAGE_NAME: 'agents-shell',
      VERIFY_IMAGE_SCRIPT: script,
      IMAGE_TAR: 'image archive.tar',
      ARCH: 'arm64',
      NIX_OCI_LOG_DIR: root,
    }
    expect(spawnSync('bash', ['-c', step.run], { cwd: root, env }).status).toBe(0)
    expect(readFileSync(join(root, 'verified'), 'utf8')).toBe('image archive.tar')
    expect(spawnSync('bash', ['-c', step.run], { cwd: root, env: { ...env, VERIFY_EXIT: '17' } }).status).toBe(17)
    for (const invalid of [
      '../outside.sh',
      'nix/verify-agents-shell-image-lifecycle.sh; touch injected',
      'nix/verify-headlamp-image-assets.sh',
    ]) {
      expect(
        spawnSync('bash', ['-c', step.run], { cwd: root, env: { ...env, VERIFY_IMAGE_SCRIPT: invalid } }).status,
      ).toBe(2)
    }
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
