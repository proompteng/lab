import { readFileSync } from 'node:fs'

import { expect, test } from 'bun:test'

const buildPushWorkflow = readFileSync(
  new URL('../../../../.github/workflows/bayn-build-push.yml', import.meta.url),
  'utf8',
)
const baynCiWorkflow = readFileSync(new URL('../../../../.github/workflows/bayn-ci.yml', import.meta.url), 'utf8')
const releaseWorkflow = readFileSync(new URL('../../../../.github/workflows/bayn-release.yml', import.meta.url), 'utf8')

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

test('holds release when the lifecycle manifest renderer changed after the built source', () => {
  expect(releaseWorkflow).toContain('git diff --quiet "$source_sha..HEAD" --')
  expect(releaseWorkflow).toContain('packages/scripts/src/bayn/lifecycle-manifests.ts \\')
  expect(releaseWorkflow.split('packages/scripts/src/bayn/lifecycle-manifests.ts').length - 1).toBe(1)
})

test('installs locked manifest renderer dependencies before executing the release renderer', () => {
  const install = 'bun install --frozen-lockfile --ignore-scripts --filter @proompteng/scripts'
  const render = 'bun packages/scripts/src/bayn/update-manifests.ts'
  expect(releaseWorkflow.split(install).length - 1).toBe(1)
  expect(releaseWorkflow.indexOf(install)).toBeLessThan(releaseWorkflow.indexOf(render))
})
