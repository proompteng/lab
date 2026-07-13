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
