import { readFileSync } from 'node:fs'

import { expect, test } from 'bun:test'

const buildPushWorkflow = readFileSync(
  new URL('../../../../.github/workflows/bayn-build-push.yml', import.meta.url),
  'utf8',
)
const baynCiWorkflow = readFileSync(new URL('../../../../.github/workflows/bayn-ci.yml', import.meta.url), 'utf8')
const releaseWorkflow = readFileSync(new URL('../../../../.github/workflows/bayn-release.yml', import.meta.url), 'utf8')
const productApplicationSet = readFileSync(
  new URL('../../../../argocd/applicationsets/product.yaml', import.meta.url),
  'utf8',
)

test('publishes the exact main push SHA without a post-merge review verifier', () => {
  expect(buildPushWorkflow).toContain('branches:\n      - main')
  expect(buildPushWorkflow).toContain('tag: sha-${{ github.sha }}')
  expect(buildPushWorkflow).toContain('source_revision: ${{ github.sha }}')
  expect(buildPushWorkflow).toContain('latest: true')
  expect(buildPushWorkflow).not.toContain('pull-requests:')
  expect(buildPushWorkflow).not.toContain('release-review-eligibility')
  expect(buildPushWorkflow).not.toContain('verify-release-review')
  expect(buildPushWorkflow).not.toContain('schedule:')
  expect(buildPushWorkflow).not.toContain('issue_comment:')
  expect(buildPushWorkflow).not.toContain('workflow_dispatch:')
})

test('keeps the existing Bayn PR gate aggregation', () => {
  expect(baynCiWorkflow).toContain('name: Bayn release gate')
  for (const check of [
    '      - changes',
    '      - pr-checks',
    '      - effect-runtime-compatibility',
    '      - broker-sandbox-contract',
    '      - postgres-integration',
    '      - dependency-input-invariant',
    '      - image',
  ]) {
    expect(baynCiWorkflow).toContain(check)
  }
  expect(baynCiWorkflow).toContain(
    'test-command: bun run --cwd services/bayn tsc && bun run --cwd services/bayn test && bun test packages/scripts/src/bayn',
  )
  expect(baynCiWorkflow).not.toContain('verify-release-review')
})

test('promotes only the exact current main build to an immutable GitOps branch', () => {
  expect(releaseWorkflow).toContain('test "$(git rev-parse HEAD)" = "$source_sha"')
  expect(releaseWorkflow).toContain('test "$(git rev-parse refs/remotes/origin/main)" = "$SOURCE_SHA"')
  expect(releaseWorkflow).toContain('DEPLOYMENT_BRANCH: codex/bayn-deploy')
  expect(releaseWorkflow).toContain(
    'git show "refs/remotes/origin/${DEPLOYMENT_BRANCH}:argocd/applications/bayn/deployment.yaml" > "$deployed_manifest"',
  )
  expect(releaseWorkflow).toContain('--deployed-deployment-path "$deployed_manifest"')
  expect(releaseWorkflow.indexOf('> "$deployed_manifest"')).toBeLessThan(
    releaseWorkflow.indexOf('git merge --no-edit "$SOURCE_SHA"'),
  )
  expect(releaseWorkflow).toContain('git push origin "HEAD:refs/heads/${DEPLOYMENT_BRANCH}"')
  expect(releaseWorkflow).not.toContain('create-pull-request')
  expect(releaseWorkflow).not.toContain('pull-requests: write')
  expect(releaseWorkflow).not.toContain('git push --force')
})

test('allows the renderer to change only the atomic Bayn deployment manifests', () => {
  for (const path of [
    'argocd/applications/bayn/kustomization.yaml',
    'argocd/applications/bayn/deployment.yaml',
    'argocd/applications/bayn/execution-controller.yaml',
    'argocd/applications/bayn/execution-activation.yaml',
    'argocd/applicationsets/product.yaml',
  ]) {
    expect(releaseWorkflow).toContain(path)
  }
  expect(releaseWorkflow).toContain('unexpected_paths="$(git diff --name-only "$SOURCE_SHA"')
})

test('points only Bayn at the generated deployment branch', () => {
  expect(productApplicationSet).toContain(
    '              - name: bayn\n                path: argocd/applications/bayn\n' +
      "                # Bayn's reviewed main build writes immutable release pins here.",
  )
  expect(productApplicationSet).toContain('                targetRevision: codex/bayn-deploy')
  expect(productApplicationSet).toContain(
    `targetRevision: '{{ if hasKey . "targetRevision" }}{{ .targetRevision }}{{ else }}main{{ end }}'`,
  )
})

test('installs locked manifest renderer dependencies before executing the release renderer', () => {
  const install = 'bun install --frozen-lockfile --ignore-scripts --filter @proompteng/scripts'
  const render = 'bun packages/scripts/src/bayn/update-manifests.ts'
  expect(releaseWorkflow.split(install).length - 1).toBe(1)
  expect(releaseWorkflow.indexOf(install)).toBeLessThan(releaseWorkflow.indexOf(render))
})
