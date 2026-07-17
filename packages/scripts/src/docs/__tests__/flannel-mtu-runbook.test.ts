import { expect, it } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { repoRoot } from '../../shared/cli'

const runbookPath = 'devices/galactic/docs/troubleshooting-networking.md'
const runbook = readFileSync(join(repoRoot, runbookPath), 'utf8')
const scriptsWorkflow = readFileSync(join(repoRoot, '.github/workflows/scripts-ci.yml'), 'utf8')

it('validates the MTU value controlled by the Flannel CNI guard', () => {
  expect(runbook).toContain("jq -e '.plugins[0].delegate.mtu == 1400'")
  expect(runbook).toContain("ip -o link show eth0 | grep -q 'mtu 1400'")
  expect(runbook).toContain('may still report `FLANNEL_MTU=1450`')
  expect(runbook).not.toContain('unless every node reports `FLANNEL_MTU=1400`')
})

it('runs the scripts regression suite when the protected runbook changes', () => {
  expect(scriptsWorkflow.split(`'${runbookPath}'`)).toHaveLength(3)
})
