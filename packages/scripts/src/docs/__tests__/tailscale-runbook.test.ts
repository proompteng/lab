import { expect, it } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { repoRoot } from '../../shared/cli'

const runbookPath = 'devices/galactic/docs/tailscale.md'
const runbook = readFileSync(join(repoRoot, runbookPath), 'utf8')
const scriptsWorkflow = readFileSync(join(repoRoot, '.github/workflows/scripts-ci.yml'), 'utf8')

it('requires every current node in the tailnet acceptance check', () => {
  expect(runbook).toContain('set -euo pipefail')
  expect(runbook).toContain('tailnet_status="$(tailscale status)"')
  expect(runbook).toContain('for node in ryzen turin altra; do')
  expect(runbook).toContain(
    'printf \'%s\\n\' "$tailnet_status" | rg -q -- "(^|[[:space:]])${node}([.-]|[[:space:]]|$)"',
  )
  expect(runbook).toContain('printf \'missing required Tailscale node: %s\\n\' "$node" >&2')
  expect(runbook).toContain('exit 1')
  expect(runbook).not.toContain("tailscale status | rg 'ryzen|turin|altra'")
  expect(runbook).not.toContain("rg -E 'ryzen|turin|altra'")
})

it('runs the scripts regression suite when the protected runbook changes', () => {
  expect(scriptsWorkflow.split(`'${runbookPath}'`)).toHaveLength(3)
})
