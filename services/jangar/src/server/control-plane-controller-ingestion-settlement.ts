import { createHash } from 'node:crypto'

import {
  buildControlPlaneControllerIngestionSettlement,
  type ControlPlaneSourceServingSnapshot,
} from '@proompteng/agent-contracts/control-plane-status'

import type {
  ControllerIngestionSettlement,
  ControllerIngestionSettlementDecision,
  ControllerIngestionSettlementTicketClass,
  ControllerIngestionSettlementTorghutCarryStatus,
  ControlPlaneControllerWitnessQuorum,
  ExecutionTrustStatus,
  ReadyTruthArbiterMode,
  ReadyTruthServingReadiness,
  RepairSlotEscrow,
  SourceServingContractVerdictExchange,
  TorghutConsumerEvidenceStatus,
  VerifyTrustForeclosureBoard,
} from '~/server/control-plane-status-types'
import type {
  AgentRunIngestionStatus,
  ControlPlaneRolloutHealth,
  DatabaseStatus,
} from '~/server/control-plane-status-types'

export const CONTROLLER_INGESTION_SETTLEMENT_DESIGN_ARTIFACT =
  'docs/agents/designs/205-jangar-controller-ingestion-settlement-and-verification-carry-cutover-2026-05-14.md'

export const CONTROLLER_INGESTION_SETTLEMENT_TORGHUT_DESIGN_ARTIFACT =
  'docs/torghut/design-system/v6/211-torghut-controller-ingestion-carry-and-alpha-no-delta-release-2026-05-14.md'

const SCHEMA_VERSION = 'jangar.controller-ingestion-settlement.v1' as const
const DEFAULT_TTL_SECONDS = 60
const ZERO_NOTIONAL_VALUES = new Set(['0', '0.0', '0.00', '0.0000'])
const MATERIAL_SOURCE_SERVING_ACTION_CLASSES = [
  'dispatch_repair',
  'dispatch_normal',
  'deploy_widen',
  'merge_ready',
] as const
const ROLLBACK_TARGET =
  'ignore controller_ingestion_settlement consumers and keep ready truth, stage credit, source-serving verdicts, and Torghut max_notional=0 as authorities'

export type BuildControllerIngestionSettlementInput = {
  now: Date
  namespace: string
  servingReadiness: ReadyTruthServingReadiness
  controllerWitness: ControlPlaneControllerWitnessQuorum
  agentRunIngestion: AgentRunIngestionStatus
  executionTrust: ExecutionTrustStatus
  database: DatabaseStatus
  rolloutHealth: ControlPlaneRolloutHealth
  sourceServingContractVerdictExchange: SourceServingContractVerdictExchange
  verifyTrustForeclosureBoard: VerifyTrustForeclosureBoard | null
  repairSlotEscrow: RepairSlotEscrow | null
  torghutConsumerEvidence: TorghutConsumerEvidenceStatus
}

const hashJson = (value: unknown, length = 16) =>
  createHash('sha256').update(JSON.stringify(value)).digest('hex').slice(0, length)

const addSeconds = (value: Date, seconds: number) => new Date(value.getTime() + seconds * 1000)

const normalizeReason = (value: string | null | undefined) =>
  value
    ?.trim()
    .toLowerCase()
    .replace(/[^a-z0-9_.:-]+/g, '_') ?? null

const uniqueStrings = (values: Array<string | null | undefined>) => [...new Set(values.filter(Boolean) as string[])]

const toControlPlaneSourceServingSnapshot = (
  exchange: SourceServingContractVerdictExchange,
): ControlPlaneSourceServingSnapshot => ({
  verdict_ref: exchange.exchange_id,
  status: exchange.status,
  fresh_until: exchange.fresh_until,
  source_head_sha: exchange.source_sha,
  serving_build_commit: exchange.serving_build_commit,
  manifest_image_digest: exchange.manifest_image_digest,
  serving_image_digest: exchange.serving_image_digest,
  allowed_action_classes: exchange.allowed_action_classes,
  repair_only_action_classes: exchange.repair_only_action_classes,
  held_action_classes: exchange.held_action_classes,
  blocked_action_classes: exchange.blocked_action_classes,
  reason_codes: exchange.reason_codes,
  evidence_refs: exchange.verdict_refs,
  rollback_target: exchange.rollback_target,
})

const parseTimestampMs = (value: string | null | undefined) => {
  if (!value) return null
  const parsed = Date.parse(value)
  return Number.isNaN(parsed) ? null : parsed
}

const isFresh = (value: string | null | undefined, now: Date) => {
  const parsed = parseTimestampMs(value)
  return Boolean(parsed && parsed > now.getTime())
}

const isZeroNotional = (value: string | null | undefined) => {
  if (!value) return true
  if (ZERO_NOTIONAL_VALUES.has(value)) return true
  const parsed = Number(value)
  return Number.isFinite(parsed) && parsed === 0
}

const freshUntilFor = (input: BuildControllerIngestionSettlementInput) => {
  const fallback = addSeconds(input.now, DEFAULT_TTL_SECONDS).toISOString()
  const times = [
    input.controllerWitness.expires_at,
    input.sourceServingContractVerdictExchange.fresh_until,
    input.verifyTrustForeclosureBoard?.fresh_until,
    input.repairSlotEscrow?.fresh_until,
    input.torghutConsumerEvidence.fresh_until,
    input.torghutConsumerEvidence.no_delta_repair_reentry_auction?.fresh_until,
  ]
    .map((value) => parseTimestampMs(value))
    .filter((value): value is number => Boolean(value && value > input.now.getTime()))

  if (times.length === 0) return fallback
  return new Date(Math.min(...times)).toISOString()
}

const torghutCarryStatus = (
  input: BuildControllerIngestionSettlementInput,
): ControllerIngestionSettlementTorghutCarryStatus => {
  if (
    input.torghutConsumerEvidence.status === 'stale' ||
    !isFresh(input.torghutConsumerEvidence.fresh_until, input.now)
  ) {
    return 'stale'
  }
  if (input.torghutConsumerEvidence.status !== 'current') return 'unavailable'

  const auction = input.torghutConsumerEvidence.no_delta_repair_reentry_auction ?? null
  if (!auction) return 'unknown'
  if (!isFresh(auction.fresh_until, input.now)) return 'stale'

  const reasons = auction.reason_codes.map((reason) => normalizeReason(reason) ?? reason)
  if (
    reasons.includes('jangar_verification_carry_contradicted') ||
    reasons.includes('jangar_controller_ingestion_contradicted')
  ) {
    return 'contradicted'
  }
  if (reasons.includes('jangar_verification_carry_lagging')) return 'lagging'
  if (reasons.includes('jangar_verification_carry_stale')) return 'stale'
  if (reasons.includes('jangar_verification_carry_unavailable')) return 'unavailable'
  if (
    auction.selected_ticket_class === 'jangar_verify_carry' ||
    auction.selected_release_condition === 'jangar_controller_ingestion_current'
  ) {
    return 'repairable'
  }
  if (auction.reentry_decision === 'allow' && auction.selected_release_condition?.startsWith('jangar_')) {
    return 'current'
  }
  return 'unknown'
}

const sourceServingMaterialDecision = (
  exchange: SourceServingContractVerdictExchange,
): SourceServingContractVerdictExchange['status'] => {
  if (
    MATERIAL_SOURCE_SERVING_ACTION_CLASSES.some((actionClass) => exchange.blocked_action_classes.includes(actionClass))
  ) {
    return 'block'
  }
  if (
    MATERIAL_SOURCE_SERVING_ACTION_CLASSES.some((actionClass) => exchange.held_action_classes.includes(actionClass))
  ) {
    return 'hold'
  }
  if (
    MATERIAL_SOURCE_SERVING_ACTION_CLASSES.some((actionClass) =>
      exchange.repair_only_action_classes.includes(actionClass),
    )
  ) {
    return 'repair_only'
  }
  return 'allow'
}

const sourceCarryReasons = (
  input: BuildControllerIngestionSettlementInput,
  carryStatus: ControllerIngestionSettlementTorghutCarryStatus,
) => {
  const materialDecision = sourceServingMaterialDecision(input.sourceServingContractVerdictExchange)
  return uniqueStrings([
    isFresh(input.sourceServingContractVerdictExchange.fresh_until, input.now) ? null : 'source_serving_verdict_stale',
    materialDecision === 'allow' ? null : `source_serving_${materialDecision}`,
    ...input.sourceServingContractVerdictExchange.reason_codes,
    input.verifyTrustForeclosureBoard
      ? isFresh(input.verifyTrustForeclosureBoard.fresh_until, input.now)
        ? null
        : 'verify_trust_foreclosure_board_stale'
      : 'verify_trust_foreclosure_board_missing',
    input.repairSlotEscrow && !isFresh(input.repairSlotEscrow.fresh_until, input.now)
      ? 'repair_slot_escrow_stale'
      : null,
    carryStatus === 'current' || carryStatus === 'unknown' ? null : `torghut_verification_carry_${carryStatus}`,
  ]).map((reason) => normalizeReason(reason) ?? reason)
}

const hasBlockingContradiction = (
  input: BuildControllerIngestionSettlementInput,
  carryStatus: ControllerIngestionSettlementTorghutCarryStatus,
  reasonCodes: string[],
) =>
  input.controllerWitness.decision === 'block' ||
  input.executionTrust.status === 'blocked' ||
  carryStatus === 'contradicted' ||
  reasonCodes.includes('capital_notional_nonzero')

const selectedTicketClass = (input: {
  decision: ControllerIngestionSettlementDecision
  controllerReasons: string[]
  sourceCarryReasons: string[]
  platformReasons: string[]
}): ControllerIngestionSettlementTicketClass => {
  if (input.decision !== 'repair_only') return 'none'
  if (
    input.controllerReasons.length > 0 &&
    input.sourceCarryReasons.length === 0 &&
    input.platformReasons.length === 0
  ) {
    return 'controller_ingestion'
  }
  return 'verification_carry_rollout'
}

const decisionFor = (input: {
  hasBlocker: boolean
  controllerReasons: string[]
  sourceCarryReasons: string[]
  platformReasons: string[]
}): ControllerIngestionSettlementDecision => {
  if (input.hasBlocker) return 'block'
  if (
    input.controllerReasons.length === 0 &&
    input.sourceCarryReasons.length === 0 &&
    input.platformReasons.length === 0
  ) {
    return 'allow'
  }
  if (
    input.controllerReasons.length > 0 &&
    input.sourceCarryReasons.length === 0 &&
    input.platformReasons.length === 0
  ) {
    return 'repair_only'
  }
  return 'hold'
}

const validationCommandsFor = (namespace: string, ticketClass: ControllerIngestionSettlementTicketClass) => {
  if (ticketClass === 'none') return []
  const statusCommand = `curl -fsS 'http://agents.agents.svc.cluster.local/v1/control-plane/status?namespace=${namespace}' | jq '.controller_ingestion_settlement'`
  if (ticketClass === 'controller_ingestion') {
    return [statusCommand, `kubectl get deployments -n ${namespace} agents-controllers`]
  }
  return [
    statusCommand,
    "curl -fsS http://torghut.torghut.svc.cluster.local/trading/revenue-repair | jq '.no_delta_repair_reentry_auction'",
  ]
}

export const buildControllerIngestionSettlement = (
  input: BuildControllerIngestionSettlementInput,
  mode: ReadyTruthArbiterMode = 'observe',
): ControllerIngestionSettlement => {
  const genericSettlement = buildControlPlaneControllerIngestionSettlement({
    now: input.now,
    namespace: input.namespace,
    mode,
    servingReadiness: input.servingReadiness,
    controllerWitness: input.controllerWitness,
    agentRunIngestion: input.agentRunIngestion,
    executionTrust: input.executionTrust,
    database: input.database,
    rolloutHealth: input.rolloutHealth,
    sourceServing: toControlPlaneSourceServingSnapshot(input.sourceServingContractVerdictExchange),
  })
  const carryStatus = torghutCarryStatus(input)
  const controllerReasons = genericSettlement.controller_reason_codes
  const sourceReasons = sourceCarryReasons(input, carryStatus)
  const nonControllerPlatformReasons = uniqueStrings([
    ...genericSettlement.platform_reason_codes,
    isZeroNotional(input.torghutConsumerEvidence.max_notional) ? null : 'capital_notional_nonzero',
  ]).map((reason) => normalizeReason(reason) ?? reason)
  const reasonCodes = uniqueStrings([...controllerReasons, ...sourceReasons, ...nonControllerPlatformReasons])
  const decision = decisionFor({
    hasBlocker: hasBlockingContradiction(input, carryStatus, reasonCodes),
    controllerReasons,
    sourceCarryReasons: sourceReasons,
    platformReasons: nonControllerPlatformReasons,
  })
  const ticketClass = selectedTicketClass({
    decision,
    controllerReasons,
    sourceCarryReasons: sourceReasons,
    platformReasons: nonControllerPlatformReasons,
  })
  const evidenceRefs = uniqueStrings([
    genericSettlement.settlement_id,
    ...genericSettlement.evidence_refs,
    input.verifyTrustForeclosureBoard?.board_id,
    input.repairSlotEscrow?.escrow_id,
    input.torghutConsumerEvidence.receipt_id,
    input.torghutConsumerEvidence.no_delta_repair_reentry_auction?.auction_id,
  ])
  const settlementId = `controller-ingestion-settlement:${input.namespace}:${hashJson({
    decision,
    reason_codes: reasonCodes,
    generic_settlement_ref: genericSettlement.settlement_id,
    verify_board_ref: input.verifyTrustForeclosureBoard?.board_id ?? null,
    repair_slot_ref: input.repairSlotEscrow?.escrow_id ?? null,
    torghut_carry_status: carryStatus,
  })}`

  return {
    schema_version: SCHEMA_VERSION,
    mode,
    settlement_id: settlementId,
    generated_at: input.now.toISOString(),
    fresh_until: freshUntilFor(input),
    namespace: input.namespace,
    governing_design_refs: uniqueStrings([
      ...genericSettlement.governing_design_refs,
      CONTROLLER_INGESTION_SETTLEMENT_DESIGN_ARTIFACT,
      CONTROLLER_INGESTION_SETTLEMENT_TORGHUT_DESIGN_ARTIFACT,
      'swarm-validation-contract:every-run-cites-governing-requirement',
    ]),
    decision,
    serving_readiness: input.servingReadiness,
    controller_witness_ref: genericSettlement.controller_witness_ref,
    controller_witness_decision: genericSettlement.controller_witness_decision,
    deployment_available: genericSettlement.deployment_available,
    watch_epoch_current: genericSettlement.watch_epoch_current,
    controller_self_report_current: genericSettlement.controller_self_report_current,
    agentrun_ingestion_current: genericSettlement.agentrun_ingestion_current,
    execution_trust_status: genericSettlement.execution_trust_status,
    database_status: genericSettlement.database_status,
    source_serving_verdict_ref: genericSettlement.source_serving_verdict_ref,
    source_serving_status: input.sourceServingContractVerdictExchange.status,
    source_head_sha: input.sourceServingContractVerdictExchange.source_sha,
    serving_build_commit: input.sourceServingContractVerdictExchange.serving_build_commit,
    manifest_image_digest: input.sourceServingContractVerdictExchange.manifest_image_digest,
    serving_image_digest: input.sourceServingContractVerdictExchange.serving_image_digest,
    verify_trust_foreclosure_board_ref: input.verifyTrustForeclosureBoard?.board_id ?? null,
    repair_slot_escrow_ref: input.repairSlotEscrow?.escrow_id ?? null,
    torghut_verification_carry_status: carryStatus,
    selected_repair_ticket: {
      ticket_class: ticketClass,
      max_parallelism: ticketClass === 'none' ? 0 : 1,
      max_notional: '0',
      validation_commands: validationCommandsFor(input.namespace, ticketClass),
      reason_codes: ticketClass === 'controller_ingestion' ? controllerReasons : sourceReasons,
    },
    reason_codes: reasonCodes,
    evidence_refs: evidenceRefs,
    rollback_target:
      input.verifyTrustForeclosureBoard?.rollback_target ?? input.repairSlotEscrow?.rollback_target ?? ROLLBACK_TARGET,
  }
}
