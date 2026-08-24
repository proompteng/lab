import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { describe, expect, test } from 'bun:test'
import YAML from 'yaml'

import { repoRoot } from '../../shared/cli'

type ArgoConfigMap = {
  readonly data?: Readonly<Record<string, string>>
}

type HealthStatus = {
  readonly message: string
  readonly status: string
}

const argoConfigMap = YAML.parse(
  readFileSync(join(repoRoot, 'argocd/applications/argocd/overlays/argocd-cm.yaml'), 'utf8'),
) as ArgoConfigMap
const agentRunHealth = argoConfigMap.data?.['resource.customizations.health.agents.proompteng.ai_AgentRun'] ?? ''

const evaluateAgentRunHealth = (objectLiteral: string): HealthStatus => {
  const program = [
    'local function evaluate(obj)',
    agentRunHealth,
    'end',
    `local health = evaluate(${objectLiteral})`,
    'io.write(health.status, "\\n", health.message)',
  ].join('\n')
  const result = spawnSync('lua', ['-'], { encoding: 'utf8', input: program })

  expect(result.status).toBe(0)
  expect(result.stderr).toBe('')

  const [status, ...messageParts] = result.stdout.trimEnd().split('\n')
  return { message: messageParts.join('\n'), status: status ?? '' }
}

describe('AgentRun Argo CD health customization', () => {
  test('waits until the Agents controller observes the current generation', () => {
    expect(
      evaluateAgentRunHealth(`{
        metadata = { generation = 2 },
        status = { observedGeneration = 1, phase = "Succeeded" },
      }`),
    ).toEqual({
      message: 'Waiting for the Agents controller to observe the current AgentRun generation.',
      status: 'Progressing',
    })
  })

  test.each(['', 'Pending', 'Queued', 'Progressing', 'Retrying', 'Running'])(
    'keeps the non-terminal %s phase progressing',
    (phase) => {
      expect(
        evaluateAgentRunHealth(`{
          metadata = { generation = 1 },
          status = { observedGeneration = 1, phase = "${phase}" },
        }`),
      ).toEqual({ message: 'Waiting for AgentRun completion.', status: 'Progressing' })
    },
  )

  test('becomes healthy only after the current AgentRun succeeds', () => {
    expect(
      evaluateAgentRunHealth(`{
        metadata = { generation = 3 },
        status = {
          observedGeneration = 3,
          phase = "Succeeded",
          message = "Smoke workload completed",
        },
      }`),
    ).toEqual({ message: 'Smoke workload completed', status: 'Healthy' })
  })

  test('keeps reusable AgentRun templates healthy', () => {
    expect(
      evaluateAgentRunHealth(`{
        metadata = { generation = 1 },
        status = { observedGeneration = 1, phase = "Template" },
      }`),
    ).toEqual({ message: 'AgentRun is a reusable template.', status: 'Healthy' })
  })

  test.each(['Failed', 'Cancelled'])('degrades the terminal %s phase', (phase) => {
    expect(
      evaluateAgentRunHealth(`{
        metadata = { generation = 4 },
        status = { observedGeneration = 4, phase = "${phase}", reason = "runtime stopped" },
      }`),
    ).toEqual({ message: 'runtime stopped', status: 'Degraded' })
  })

  test('degrades unsupported phases instead of treating the hook as complete', () => {
    expect(
      evaluateAgentRunHealth(`{
        metadata = { generation = 1 },
        status = { observedGeneration = 1, phase = "Unknown" },
      }`),
    ).toEqual({ message: 'AgentRun reported unsupported phase Unknown.', status: 'Degraded' })
  })
})
