import { fetchExecutionTrustFromAgentsService } from '@proompteng/agent-contracts/execution-trust-client'
import {
  buildExecutionTrust as buildExecutionTrustFromResources,
  DEFAULT_EXECUTION_TRUST_SUMMARY_LIMIT,
  type ExecutionTrustInput,
  type ExecutionTrustSnapshot,
  type ExecutionTrustSwarmLister,
  type ExecutionTrustSwarmResource,
} from '@proompteng/agent-contracts/execution-trust'

import { resolveControlPlaneStatusConfig } from '~/server/control-plane-config'

export type { ExecutionTrustInput, ExecutionTrustSnapshot, ExecutionTrustSwarmLister, ExecutionTrustSwarmResource }

const normalizeMessage = (value: unknown) => (value instanceof Error ? value.message : String(value))

const resolveExecutionTrustSwarms = () => resolveControlPlaneStatusConfig(process.env).executionTrustSwarms

export const resolveExecutionTrustSummaryLimit = () =>
  resolveControlPlaneStatusConfig(process.env).executionTrustSummaryLimit

const unknownSnapshot = (namespace: string, now: Date, error: unknown): ExecutionTrustSnapshot => ({
  executionTrust: {
    status: 'unknown',
    reason: `execution trust snapshot unavailable: ${normalizeMessage(error)}`,
    last_evaluated_at: now.toISOString(),
    blocking_windows: [],
    evidence_summary: [],
  },
  swarms: [],
  stages: [],
})

export const buildExecutionTrust = async ({
  namespace,
  now,
  swarms,
  listSwarms,
  summaryLimit,
}: ExecutionTrustInput): Promise<ExecutionTrustSnapshot> => {
  const resolvedSwarms = swarms.length > 0 ? swarms : resolveExecutionTrustSwarms()
  const resolvedSummaryLimit =
    summaryLimit ??
    resolveControlPlaneStatusConfig(process.env).executionTrustSummaryLimit ??
    DEFAULT_EXECUTION_TRUST_SUMMARY_LIMIT

  if (listSwarms) {
    return buildExecutionTrustFromResources({
      namespace,
      now,
      swarms: resolvedSwarms,
      listSwarms,
      summaryLimit: resolvedSummaryLimit,
    })
  }

  const result = await fetchExecutionTrustFromAgentsService({
    namespace,
    swarms: resolvedSwarms,
    summaryLimit: resolvedSummaryLimit,
  })

  if (result.ok) return result.body
  return unknownSnapshot(namespace, now, result.error ?? `Agents service returned HTTP ${result.status}`)
}
