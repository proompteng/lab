import { expect, it } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { repoRoot } from '../../shared/cli'

it('keeps Agents handoff shell snippets directly executable', () => {
  const runbook = readFileSync(join(repoRoot, 'docs/agents/designs/handoff-common.md'), 'utf8')
  const scriptsWorkflow = readFileSync(join(repoRoot, '.github/workflows/scripts-ci.yml'), 'utf8')

  expect(runbook).not.toContain('\\"')
  expect(runbook).toContain("rg -n '^kind: (Deployment|Service|CustomResourceDefinition)$' /tmp/agents.yaml | head")
  expect(runbook).toContain("kubectl get application -n argocd agents -o yaml | rg -n 'sync|health|revision'")
  expect(runbook).toContain("kubectl get crd | rg 'proompteng\\.ai'")
  expect(
    scriptsWorkflow.split('\n').filter((line) => line.trim() === "- 'docs/agents/designs/handoff-common.md'"),
  ).toHaveLength(2)
})
