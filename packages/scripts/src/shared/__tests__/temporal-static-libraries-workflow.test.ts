import { expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { repoRoot } from '../cli'

test('Temporal static library workflow preserves artifact permissions', () => {
  const workflow = readFileSync(join(repoRoot, '.github/workflows/temporal-static-libraries.yml'), 'utf8')
  const permissions = workflow.match(/\npermissions:\n([\s\S]*?)\n\njobs:/)?.[1]

  expect(permissions).toContain('actions: write')
  expect(permissions).toContain('contents: write')
  expect(workflow).toContain('actions/upload-artifact@v5')
  expect(workflow).toContain('actions/download-artifact@v6')
})

test('Temporal package release skips label updates when no release PR is found', () => {
  const workflow = readFileSync(join(repoRoot, '.github/workflows/temporal-bun-sdk.yml'), 'utf8')

  expect(workflow).toContain("--jq '.[0].number // empty'")
  expect(workflow).toContain('if [[ -n "$pr_number" ]]; then')
})

test('Temporal Bun SDK keeps PR validation fast and reserves remote load gates for main and releases', () => {
  const workflow = readFileSync(join(repoRoot, '.github/workflows/temporal-bun-sdk.yml'), 'utf8')
  const testJob = workflow.match(/\n  test:\n([\s\S]*?)\n  integration:/)?.[1]
  const integrationJob = workflow.match(/\n  integration:\n([\s\S]*?)\n  prepare-release:/)?.[1]

  expect(testJob).toContain('runs-on: ubuntu-latest')
  expect(testJob).toContain("! -path 'tests/integration/*'")
  expect(testJob).toContain('No Temporal Bun SDK non-integration tests were discovered.')
  expect(testJob).not.toContain('Install Temporal CLI')
  expect(testJob).not.toContain('test:load')
  expect(integrationJob).toContain("if: github.event_name != 'pull_request'")
  expect(integrationJob).toContain('runs-on: arc-arm64')
  expect(integrationJob).toContain('bun test tests/integration')
  expect(integrationJob).toContain('test:load')
  expect(workflow).toContain('needs:\n      - test\n      - integration')
  expect(workflow.match(/- '\.github\/workflows\/temporal-bun-sdk\.yml'/g)).toHaveLength(2)
})
