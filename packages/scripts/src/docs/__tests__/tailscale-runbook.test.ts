import { expect, it } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { repoRoot } from '../../shared/cli'

const runbookPath = 'devices/galactic/docs/tailscale.md'
const runbook = readFileSync(join(repoRoot, runbookPath), 'utf8')
const scriptsWorkflow = readFileSync(join(repoRoot, '.github/workflows/scripts-ci.yml'), 'utf8')

it('uses ripgrep alternation without treating the pattern as an encoding', () => {
  expect(runbook).toContain("tailscale status | rg 'ryzen|turin|altra'")
  expect(runbook).not.toContain("rg -E 'ryzen|turin|altra'")
})

it('runs the scripts regression suite when the protected runbook changes', () => {
  expect(scriptsWorkflow.split(`'${runbookPath}'`)).toHaveLength(3)
})
