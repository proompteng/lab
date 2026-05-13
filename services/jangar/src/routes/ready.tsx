import { createFileRoute } from '@tanstack/react-router'

import type { ExecutionTrustStatus } from '~/data/agents-control-plane'
import { assessAgentRunIngestion, getAgentsControllerHealth } from '~/server/agents-controller'
import { buildRuntimeAdmissionSnapshot, findAdmissionPassport } from '~/server/control-plane-runtime-admission'
import { buildRepairBidAdmissionState } from '~/server/control-plane-repair-bid-admission'
import { getLeaderElectionStatus } from '~/server/leader-election'
import { getMemoryProviderHealth } from '~/server/memory-provider-health'
import { getOrchestrationControllerHealth } from '~/server/orchestration-controller'
import { getSupportingControllerHealth } from '~/server/supporting-primitives-controller'
import { buildExecutionTrust } from '~/server/control-plane-status'
import { resolveTorghutConsumerEvidence } from '~/server/control-plane-torghut-consumer-evidence'

const isControllerHealthReady = (health: ReturnType<typeof getAgentsControllerHealth>) =>
  !health.enabled || health.crdsReady !== false

const isAgentRunIngestionReady = (health: ReturnType<typeof getAgentsControllerHealth>) => {
  if (!health.enabled) return true
  if (!health.started) return false
  const namespaces = health.namespaces?.length ? health.namespaces : ['agents']
  return namespaces.every((namespace) => assessAgentRunIngestion(namespace, health).status !== 'degraded')
}

const isStandbyLeaderElectionReady = (leaderElection: ReturnType<typeof getLeaderElectionStatus>) =>
  leaderElection.lastAttemptAt !== null && leaderElection.lastError === null

const uniqueStrings = (values: string[]) => [...new Set(values.filter((value) => value.length > 0))]

const EXECUTION_TRUST_STATUS_PRIORITY: Record<ExecutionTrustStatus['status'], number> = {
  healthy: 0,
  degraded: 1,
  unknown: 2,
  blocked: 3,
}

const summarizeExecutionTrustReason = (input: {
  status: ExecutionTrustStatus['status']
  namespaces: string[]
  reasons: string[]
}) => {
  const reasons = uniqueStrings(input.reasons)
  if (input.status === 'healthy') {
    return input.namespaces.length > 1
      ? `execution trust is healthy across ${input.namespaces.length} namespaces`
      : (reasons[0] ?? 'execution trust is healthy')
  }

  const statusLabel = input.status === 'blocked' ? 'blocked' : input.status === 'unknown' ? 'unknown' : 'degraded'
  const prefix =
    input.namespaces.length > 1
      ? `execution trust ${statusLabel} across ${input.namespaces.length} namespaces`
      : `execution trust ${statusLabel}`

  return reasons.length > 0 ? `${prefix}: ${reasons.join('; ')}` : prefix
}

const mergeExecutionTrustStatuses = (input: {
  now: Date
  namespaces: string[]
  trusts: ExecutionTrustStatus[]
}): ExecutionTrustStatus => {
  const mergedStatus = input.trusts.reduce<ExecutionTrustStatus['status']>((status, trust) => {
    return EXECUTION_TRUST_STATUS_PRIORITY[trust.status] > EXECUTION_TRUST_STATUS_PRIORITY[status]
      ? trust.status
      : status
  }, 'healthy')

  return {
    status: mergedStatus,
    reason: summarizeExecutionTrustReason({
      status: mergedStatus,
      namespaces: input.namespaces,
      reasons: input.trusts.map((trust) => trust.reason),
    }),
    last_evaluated_at: input.now.toISOString(),
    blocking_windows: input.trusts.flatMap((trust) => trust.blocking_windows),
    evidence_summary: uniqueStrings(input.trusts.flatMap((trust) => trust.evidence_summary)),
  }
}

const executionTrustStatus = async (namespaces: string[]) => {
  const now = new Date()
  const resolvedNamespaces = uniqueStrings(namespaces.length > 0 ? namespaces : ['agents'])
  const trusts = await Promise.all(
    resolvedNamespaces.map(async (namespace): Promise<ExecutionTrustStatus> => {
      try {
        return (
          await buildExecutionTrust({
            namespace,
            now,
            swarms: [],
          })
        ).executionTrust
      } catch {
        return {
          status: 'unknown',
          reason: `execution trust check failed for namespace ${namespace}`,
          last_evaluated_at: now.toISOString(),
          blocking_windows: [],
          evidence_summary: [],
        }
      }
    }),
  )

  return mergeExecutionTrustStatuses({
    now,
    namespaces: resolvedNamespaces,
    trusts,
  })
}

export const Route = createFileRoute('/ready')({
  server: {
    handlers: {
      GET: () => getReadyHandler(),
    },
  },
})

export const getReadyHandler = async () => {
  const now = new Date()
  const leaderElection = getLeaderElectionStatus()
  const agentsController = getAgentsControllerHealth()
  const orchestrationController = getOrchestrationControllerHealth()
  const supportingController = getSupportingControllerHealth()
  const namespaces = agentsController.namespaces?.length ? agentsController.namespaces : ['agents']
  const trust = await executionTrustStatus(namespaces)
  const torghutConsumerEvidence = await resolveTorghutConsumerEvidence(now)
  const repairBidAdmission = buildRepairBidAdmissionState({
    now,
    namespace: namespaces[0] ?? 'agents',
    repository: process.env.CODEX_REPOSITORY ?? process.env.CODEX_REPO_SLUG,
    branch: process.env.CODEX_BRANCH,
    swarmName: process.env.SWARM_NAME,
    stage: process.env.SWARM_STAGE ?? process.env.CODEX_STAGE,
    torghutConsumerEvidence: torghutConsumerEvidence.status,
  })
  const memoryProvider = getMemoryProviderHealth()
  const runtimeAdmission = buildRuntimeAdmissionSnapshot({
    now,
    executionTrust: trust,
  })
  const servingPassport = findAdmissionPassport({
    admissionPassports: runtimeAdmission.admissionPassports,
    consumerClass: 'serving',
  })
  const recoveryWarrants = runtimeAdmission.recoveryWarrants ?? []
  const runtimeProofCells = runtimeAdmission.runtimeProofCells ?? []
  const projectionWatermarks = runtimeAdmission.projectionWatermarks ?? []
  const servingRecoveryWarrant =
    recoveryWarrants.find((warrant) => warrant.execution_class === 'serving' && warrant.status !== 'superseded') ?? null
  const servingRuntimeProofCells = servingRecoveryWarrant
    ? runtimeProofCells.filter((cell) =>
        servingRecoveryWarrant.required_proof_cell_ids.includes(cell.runtime_proof_cell_id),
      )
    : []
  const servingRuntimeProofCellsHealthy =
    servingRecoveryWarrant !== null &&
    servingRuntimeProofCells.every((cell) => !cell.required || cell.status === 'healthy')

  const controllersOk =
    isControllerHealthReady(agentsController) &&
    isControllerHealthReady(orchestrationController) &&
    isControllerHealthReady(supportingController)
  const leaderRequired = leaderElection.required
  const activeControllerReplica = !leaderRequired || leaderElection.isLeader
  const leaderElectionReady = activeControllerReplica || isStandbyLeaderElectionReady(leaderElection)
  const agentsControllerHealthy = activeControllerReplica
    ? isAgentRunIngestionReady(agentsController)
    : leaderElectionReady
  const servingPassportReady =
    servingPassport !== undefined && servingPassport.decision !== 'block' && servingPassport.decision !== 'hold'
  const memoryProviderReady = memoryProvider.status !== 'blocked'
  const ready = controllersOk && leaderElectionReady && memoryProviderReady
  const status = ready && agentsControllerHealthy && servingPassportReady ? 'ok' : 'degraded'

  const body = JSON.stringify({
    status,
    service: 'jangar' as const,
    leaderElection,
    agentsController,
    orchestrationController,
    supportingController,
    execution_trust: trust,
    torghut_consumer_evidence: torghutConsumerEvidence.status,
    repair_bid_admission: repairBidAdmission,
    memory_provider: memoryProvider,
    runtime_kits: runtimeAdmission.runtimeKits,
    admission_passports: runtimeAdmission.admissionPassports,
    serving_passport_id: runtimeAdmission.servingPassportId,
    recovery_warrants: recoveryWarrants,
    runtime_proof_cells: runtimeProofCells,
    projection_watermarks: projectionWatermarks,
    serving_recovery_warrant_id: servingRecoveryWarrant?.recovery_warrant_id ?? null,
    serving_runtime_proof_cells_healthy: servingRuntimeProofCellsHealthy,
  })

  const headers: Record<string, string> = {
    'content-type': 'application/json',
    'content-length': Buffer.byteLength(body).toString(),
  }

  return new Response(body, {
    status: ready ? 200 : 503,
    headers,
  })
}
