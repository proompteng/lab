import { createHash } from 'node:crypto'

import type {
  EvidencePressureLedger,
  MaterialReentryClearinghouse,
  MaterialReentryReceipt,
  RepairSlot,
  RepairSlotEscrow,
  RepairSlotEscrowMode,
  RepairSlotEscrowStatus,
  RepairSlotNoDeltaDebt,
  StageCreditAccount,
  StageCreditLedger,
  TorghutConsumerEvidenceStatus,
  TorghutExecutableAlphaRepairReceipt,
  TorghutRevenueRepairQueueItem,
} from '~/data/agents-control-plane'

export const REPAIR_SLOT_ESCROW_DESIGN_ARTIFACT =
  'docs/agents/designs/194-jangar-receipt-settled-repair-slots-and-stage-custody-thaw-2026-05-14.md'

export const REPAIR_SLOT_ESCROW_TORGHUT_DESIGN_ARTIFACT =
  'docs/torghut/design-system/v6/199-torghut-executable-alpha-settlement-slots-and-no-delta-repair-custody-2026-05-14.md'

const SCHEMA_VERSION = 'jangar.repair-slot-escrow.v1' as const
const DEFAULT_FRESHNESS_MS = 60 * 1000
const DEFAULT_MAX_RUNTIME_SECONDS = 20 * 60
const ROLLBACK_TARGET =
  'set JANGAR_REPAIR_SLOT_ESCROW_MODE=observe or JANGAR_REPAIR_SLOT_ESCROW_ENABLED=false; keep Torghut max_notional=0'

type BuildRepairSlotEscrowInput = {
  now: Date
  namespace: string
  torghutConsumerEvidence: TorghutConsumerEvidenceStatus
  materialReentryClearinghouse?: MaterialReentryClearinghouse | null
  stageCreditLedger?: StageCreditLedger | null
  evidencePressureLedger?: EvidencePressureLedger | null
  mode?: RepairSlotEscrowMode
}

const hashJson = (value: unknown, length = 18) =>
  createHash('sha256').update(JSON.stringify(value)).digest('hex').slice(0, length)

const uniqueStrings = (values: Array<string | null | undefined>) => [
  ...new Set(values.filter((value): value is string => Boolean(value && value.trim().length > 0))),
]

const stableKeyPart = (value: string | null | undefined, fallback = 'unknown') => {
  const trimmed = value?.trim()
  return trimmed && trimmed.length > 0 ? trimmed : fallback
}

const parseFutureTime = (value: string | null | undefined, nowMs: number) => {
  if (!value) return null
  const parsed = Date.parse(value)
  return Number.isFinite(parsed) && parsed > nowMs ? parsed : null
}

const freshUntilFor = (now: Date, values: Array<string | null | undefined>) => {
  const nowMs = now.getTime()
  const candidates = values
    .map((value) => parseFutureTime(value, nowMs))
    .filter((value): value is number => value !== null)
    .sort((left, right) => left - right)
  return new Date(candidates[0] ?? nowMs + DEFAULT_FRESHNESS_MS).toISOString()
}

const isFresh = (value: string | null | undefined, now: Date) => parseFutureTime(value, now.getTime()) !== null

const normalizeMode = (value: string | undefined): RepairSlotEscrowMode =>
  value === 'shadow' || value === 'hold' || value === 'enforce' ? value : 'observe'

export const resolveRepairSlotEscrowMode = () => normalizeMode(process.env.JANGAR_REPAIR_SLOT_ESCROW_MODE)

export const isRepairSlotEscrowEnabled = () => {
  const configured = process.env.JANGAR_REPAIR_SLOT_ESCROW_ENABLED?.trim().toLowerCase()
  return configured !== '0' && configured !== 'false' && configured !== 'no' && configured !== 'disabled'
}

const alphaReadinessQueueItem = (
  torghutConsumerEvidence: TorghutConsumerEvidenceStatus,
): TorghutRevenueRepairQueueItem | null => {
  const blocker = torghutConsumerEvidence.alpha_readiness_strike_ledger?.selected_business_blocker
  if (!blocker) return null
  return {
    code: blocker.code,
    reason: blocker.reason,
    dimension: 'alpha_readiness',
    action: 'clear_hypothesis_blockers_before_capital',
    priority: null,
    expected_unblock_value: null,
    source: torghutConsumerEvidence.alpha_readiness_strike_ledger?.revenue_repair_digest_ref ?? null,
    value_gate: blocker.value_gate,
    required_output_receipt: blocker.required_output_receipt,
    required_receipts: torghutConsumerEvidence.alpha_readiness_strike_ledger?.required_after_receipts ?? [],
    max_notional: torghutConsumerEvidence.alpha_readiness_strike_ledger?.max_notional ?? null,
    capital_rule: torghutConsumerEvidence.alpha_readiness_strike_ledger?.strike_slots[0]?.capital_rule ?? null,
    observed_count: torghutConsumerEvidence.alpha_readiness_strike_ledger?.routeable_candidate_count_before ?? null,
  }
}

const topRepairQueueItem = (torghutConsumerEvidence: TorghutConsumerEvidenceStatus) =>
  torghutConsumerEvidence.revenue_repair_queue?.[0] ?? alphaReadinessQueueItem(torghutConsumerEvidence)

const zeroNotional = (value: string | number | null | undefined) => {
  if (value === null || value === undefined) return false
  const normalized = String(value).trim()
  return normalized === '0' || normalized === '0.0' || normalized === '0.00'
}

const knownZeroNotional = (values: Array<string | number | null | undefined>) =>
  values.filter((value) => value !== null && value !== undefined).every(zeroNotional)

const selectedExecutableAlphaReceipt = (torghutConsumerEvidence: TorghutConsumerEvidenceStatus) =>
  torghutConsumerEvidence.executable_alpha_repair_receipts?.selected_receipt ?? null

const sourceRevenueRepairRef = (
  torghutConsumerEvidence: TorghutConsumerEvidenceStatus,
  receipt: TorghutExecutableAlphaRepairReceipt | null,
) =>
  receipt?.source_revenue_repair_ref ??
  torghutConsumerEvidence.executable_alpha_repair_receipts?.source_revenue_repair_ref ??
  torghutConsumerEvidence.alpha_readiness_strike_ledger?.revenue_repair_digest_ref ??
  null

const sourceRefsAgree = (
  torghutConsumerEvidence: TorghutConsumerEvidenceStatus,
  receipt: TorghutExecutableAlphaRepairReceipt | null,
) => {
  const refs = uniqueStrings([
    receipt?.source_revenue_repair_ref,
    torghutConsumerEvidence.executable_alpha_repair_receipts?.source_revenue_repair_ref,
    torghutConsumerEvidence.alpha_readiness_strike_ledger?.revenue_repair_digest_ref,
  ])
  return refs.length <= 1
}

const receiptMatchesSelectedRepair = (
  receipt: MaterialReentryReceipt,
  selectedReceipt: TorghutExecutableAlphaRepairReceipt,
) =>
  receipt.receipt_class === 'torghut_executable_alpha_repair' &&
  receipt.required_output_receipt === 'torghut.executable-alpha-receipts.v1' &&
  (receipt.source_hold_refs.includes(selectedReceipt.receipt_id) ||
    receipt.evidence_refs.includes(selectedReceipt.receipt_id))

const materialReceiptForSelectedRepair = (
  clearinghouse: MaterialReentryClearinghouse | null | undefined,
  selectedReceipt: TorghutExecutableAlphaRepairReceipt | null,
) => {
  if (!clearinghouse || !selectedReceipt) return null
  const receipts = clearinghouse.action_receipts.filter((receipt) =>
    receiptMatchesSelectedRepair(receipt, selectedReceipt),
  )
  return receipts.find((receipt) => receipt.action_class === 'dispatch_repair') ?? receipts[0] ?? null
}

const stageCreditAccount = (ledger: StageCreditLedger | null | undefined): StageCreditAccount | null =>
  ledger?.stage_accounts.find((account) => account.action_class === 'dispatch_repair') ?? null

const evidencePressureBudget = (ledger: EvidencePressureLedger | null | undefined) =>
  ledger?.action_pressure_budget.find((budget) => budget.action_class === 'dispatch_repair') ?? null

const slotStateForMode = (mode: RepairSlotEscrowMode): RepairSlot['state'] => {
  if (mode === 'hold') return 'held'
  if (mode === 'enforce') return 'open'
  return 'observe_only'
}

const statusForMode = (mode: RepairSlotEscrowMode): RepairSlotEscrowStatus => {
  if (mode === 'hold') return 'hold'
  if (mode === 'enforce') return 'open'
  return 'observe_only'
}

const selectedValueGate = (
  queueItem: TorghutRevenueRepairQueueItem | null,
  receipt: TorghutExecutableAlphaRepairReceipt | null,
  torghutConsumerEvidence: TorghutConsumerEvidenceStatus,
) =>
  receipt?.target_value_gate ??
  torghutConsumerEvidence.executable_alpha_repair_receipts?.target_value_gate ??
  queueItem?.value_gate ??
  null

const selectedRequiredReceipts = (
  queueItem: TorghutRevenueRepairQueueItem | null,
  receipt: TorghutExecutableAlphaRepairReceipt | null,
  materialReceipt: MaterialReentryReceipt | null,
) =>
  uniqueStrings([
    ...(receipt?.required_output_receipts ?? []),
    queueItem?.required_output_receipt,
    ...(queueItem?.required_receipts ?? []),
    materialReceipt?.required_output_receipt,
  ])

const selectedValidationCommands = (
  receipt: TorghutExecutableAlphaRepairReceipt | null,
  materialReceipt: MaterialReentryReceipt | null,
) =>
  uniqueStrings([
    ...(receipt?.validation_commands ?? []),
    ...(materialReceipt?.required_validation_commands ?? []),
    "curl -fsS http://torghut.torghut.svc.cluster.local/trading/revenue-repair | jq '.executable_alpha_repair_receipts.selected_receipt'",
  ])

const selectedBeforeRefs = (
  torghutConsumerEvidence: TorghutConsumerEvidenceStatus,
  receipt: TorghutExecutableAlphaRepairReceipt | null,
  materialReceipt: MaterialReentryReceipt | null,
  stageAccount: StageCreditAccount | null,
) =>
  uniqueStrings([
    torghutConsumerEvidence.receipt_id,
    torghutConsumerEvidence.alpha_readiness_strike_ledger?.ledger_id,
    sourceRevenueRepairRef(torghutConsumerEvidence, receipt),
    receipt?.receipt_id,
    materialReceipt?.receipt_id,
    stageAccount?.account_id,
    ...(receipt?.required_input_refs ?? []),
  ])

const slotDedupeKey = (input: {
  torghutConsumerEvidence: TorghutConsumerEvidenceStatus
  queueItem: TorghutRevenueRepairQueueItem | null
  receipt: TorghutExecutableAlphaRepairReceipt | null
  valueGate: string | null
  validationCommands: string[]
}) => {
  const digest = hashJson(
    {
      sourceRevenueRepairRef: sourceRevenueRepairRef(input.torghutConsumerEvidence, input.receipt),
      selectedReceiptId: input.receipt?.receipt_id ?? null,
      hypothesisId: input.receipt?.hypothesis_id ?? null,
      targetValueGate: input.valueGate,
      blockerSet: uniqueStrings([input.queueItem?.reason, ...(input.receipt?.reason_codes ?? [])]).sort(),
      sourceCommit: input.torghutConsumerEvidence.build_commit ?? null,
      servingRevision: input.torghutConsumerEvidence.serving_revision ?? null,
      validationCommands: input.validationCommands,
    },
    18,
  )
  return `repair-slot:torghut-executable-alpha:${digest}:${stableKeyPart(input.valueGate)}`
}

const noDeltaDebtsForSlot = (input: {
  torghutConsumerEvidence: TorghutConsumerEvidenceStatus
  receipt: TorghutExecutableAlphaRepairReceipt | null
  valueGate: string | null
  dedupeKey: string
}) => {
  const debts: RepairSlotNoDeltaDebt[] = []
  const conveyor = input.torghutConsumerEvidence.alpha_readiness_settlement_conveyor
  if (
    conveyor?.no_delta_release_key &&
    conveyor.repeat_launch_decision === 'deny' &&
    (!conveyor.selected_hypothesis_id || conveyor.selected_hypothesis_id === input.receipt?.hypothesis_id) &&
    (!conveyor.selected_value_gate || conveyor.selected_value_gate === input.valueGate)
  ) {
    debts.push({
      debt_id: `repair-slot-no-delta:${hashJson(['conveyor', conveyor.no_delta_release_key, input.dedupeKey])}`,
      dedupe_key: input.dedupeKey,
      no_delta_release_key: conveyor.no_delta_release_key,
      source: 'alpha_readiness_settlement_conveyor',
      source_ref: conveyor.conveyor_id,
      selected_hypothesis_id: conveyor.selected_hypothesis_id,
      selected_value_gate: conveyor.selected_value_gate,
      measured_delta: conveyor.measured_routeable_candidate_delta,
      repeat_launch_decision: conveyor.repeat_launch_decision,
      reason_codes: conveyor.reason_codes,
      rollback_target: conveyor.rollback_target,
    })
  }

  const dividend = input.torghutConsumerEvidence.alpha_repair_dividend_ledger
  if (
    dividend?.no_delta_release_key &&
    dividend.launch_decision === 'deny' &&
    (!dividend.selected_hypothesis_id || dividend.selected_hypothesis_id === input.receipt?.hypothesis_id) &&
    (!dividend.selected_value_gate || dividend.selected_value_gate === input.valueGate)
  ) {
    debts.push({
      debt_id: `repair-slot-no-delta:${hashJson(['dividend', dividend.no_delta_release_key, input.dedupeKey])}`,
      dedupe_key: input.dedupeKey,
      no_delta_release_key: dividend.no_delta_release_key,
      source: 'alpha_repair_dividend_ledger',
      source_ref: dividend.ledger_id,
      selected_hypothesis_id: dividend.selected_hypothesis_id,
      selected_value_gate: dividend.selected_value_gate,
      measured_delta: dividend.measured_delta,
      repeat_launch_decision: dividend.launch_decision,
      reason_codes: dividend.reason_codes,
      rollback_target: dividend.rollback_target,
    })
  }

  return debts
}

const blockReasons = (input: {
  now: Date
  queueItem: TorghutRevenueRepairQueueItem | null
  torghutConsumerEvidence: TorghutConsumerEvidenceStatus
  receipt: TorghutExecutableAlphaRepairReceipt | null
  materialReentryClearinghouse: MaterialReentryClearinghouse | null | undefined
  materialReceipt: MaterialReentryReceipt | null
  stageCreditLedger: StageCreditLedger | null | undefined
  stageAccount: StageCreditAccount | null
  evidencePressureLedger: EvidencePressureLedger | null | undefined
  noDeltaDebt: RepairSlotNoDeltaDebt[]
}) => {
  const pressureBudget = evidencePressureBudget(input.evidencePressureLedger)

  return uniqueStrings([
    input.queueItem?.code !== 'repair_alpha_readiness' ? 'top_repair_queue_item_not_alpha_readiness' : null,
    input.queueItem?.required_output_receipt &&
    input.queueItem.required_output_receipt !== 'torghut.executable-alpha-receipts.v1'
      ? 'top_repair_required_output_not_executable_alpha_receipts'
      : null,
    input.torghutConsumerEvidence.status !== 'current'
      ? `torghut_consumer_evidence_${input.torghutConsumerEvidence.status}`
      : null,
    !input.receipt ? 'selected_executable_alpha_receipt_missing' : null,
    input.receipt && !isFresh(input.receipt.fresh_until, input.now) ? 'selected_executable_alpha_receipt_stale' : null,
    input.receipt && !zeroNotional(input.receipt.max_notional) ? 'selected_receipt_not_zero_notional' : null,
    input.receipt?.capital_rule && input.receipt.capital_rule !== 'zero_notional_repair_only'
      ? 'selected_receipt_capital_rule_not_zero_notional_repair_only'
      : null,
    input.receipt &&
    !knownZeroNotional([
      input.torghutConsumerEvidence.max_notional,
      input.torghutConsumerEvidence.executable_alpha_repair_receipts?.max_notional,
      input.queueItem?.max_notional,
    ])
      ? 'torghut_not_zero_notional'
      : null,
    input.receipt && !sourceRevenueRepairRef(input.torghutConsumerEvidence, input.receipt)
      ? 'source_revenue_repair_ref_missing'
      : null,
    !sourceRefsAgree(input.torghutConsumerEvidence, input.receipt)
      ? 'selected_receipt_source_revenue_repair_ref_mismatch'
      : null,
    !input.materialReentryClearinghouse ? 'material_reentry_clearinghouse_missing' : null,
    input.materialReentryClearinghouse && !isFresh(input.materialReentryClearinghouse.fresh_until, input.now)
      ? 'material_reentry_clearinghouse_stale'
      : null,
    input.materialReentryClearinghouse && !input.materialReceipt
      ? 'material_reentry_receipt_missing_for_selected_executable_alpha'
      : null,
    input.materialReceipt && input.materialReceipt.action_class !== 'dispatch_repair'
      ? 'material_reentry_receipt_not_dispatch_repair'
      : null,
    input.materialReceipt && input.materialReceipt.status === 'blocked' ? 'material_reentry_receipt_blocked' : null,
    input.materialReceipt && !isFresh(input.materialReceipt.fresh_until, input.now)
      ? 'material_reentry_receipt_stale'
      : null,
    !input.stageCreditLedger ? 'stage_credit_ledger_missing' : null,
    input.stageCreditLedger && !isFresh(input.stageCreditLedger.fresh_until, input.now)
      ? 'stage_credit_ledger_stale'
      : null,
    input.stageCreditLedger && input.stageCreditLedger.evidence_mode === 'enforce'
      ? 'stage_credit_enforce_mode_not_shadow_proven'
      : null,
    input.stageCreditLedger && !input.stageAccount ? 'stage_credit_dispatch_repair_account_missing' : null,
    input.stageAccount && input.stageAccount.max_notional !== 0 ? 'stage_credit_account_not_zero_notional' : null,
    input.evidencePressureLedger && !isFresh(input.evidencePressureLedger.fresh_until, input.now)
      ? 'evidence_pressure_ledger_stale'
      : null,
    input.evidencePressureLedger && !pressureBudget ? 'evidence_pressure_dispatch_repair_budget_missing' : null,
    pressureBudget?.decision === 'block' ? 'evidence_pressure_dispatch_repair_blocked' : null,
    pressureBudget?.decision === 'hold' ? 'evidence_pressure_dispatch_repair_held' : null,
    pressureBudget && (pressureBudget.max_dispatches ?? 0) < 1 ? 'evidence_pressure_dispatch_repair_budget_zero' : null,
    pressureBudget && pressureBudget.max_notional !== 0
      ? 'evidence_pressure_dispatch_repair_budget_not_zero_notional'
      : null,
    ...(input.noDeltaDebt.length > 0 ? ['active_no_delta_debt_for_repair_slot'] : []),
  ])
}

const buildSlot = (input: {
  state: RepairSlot['state']
  reasonCodes: string[]
  torghutConsumerEvidence: TorghutConsumerEvidenceStatus
  receipt: TorghutExecutableAlphaRepairReceipt | null
  materialReceipt: MaterialReentryReceipt | null
  stageCreditLedger: StageCreditLedger | null | undefined
  stageAccount: StageCreditAccount | null
  evidencePressureLedger: EvidencePressureLedger | null | undefined
  queueItem: TorghutRevenueRepairQueueItem | null
  valueGate: string | null
  dedupeKey: string
  validationCommands: string[]
  requiredReceipts: string[]
}) => {
  const pressureBudget = evidencePressureBudget(input.evidencePressureLedger)
  const maxParallelism = Math.max(
    0,
    Math.min(
      1,
      input.materialReceipt?.max_parallelism ?? 0,
      input.stageAccount?.max_concurrent_runs ?? 0,
      pressureBudget?.max_dispatches ?? 1,
    ),
  )
  const maxRuntimeSeconds =
    input.materialReceipt?.max_runtime_seconds ??
    input.stageAccount?.max_runtime_seconds ??
    pressureBudget?.max_runtime_seconds ??
    DEFAULT_MAX_RUNTIME_SECONDS

  return {
    slot_id: `repair-slot:${hashJson([input.dedupeKey, input.materialReceipt?.receipt_id, input.stageAccount?.account_id])}`,
    action_class: 'dispatch_repair',
    state: input.state,
    source_revenue_repair_ref: sourceRevenueRepairRef(input.torghutConsumerEvidence, input.receipt),
    torghut_selected_receipt_id: input.receipt?.receipt_id ?? null,
    torghut_selected_receipt_schema: input.receipt?.schema_version ?? null,
    material_reentry_receipt_id: input.materialReceipt?.receipt_id ?? null,
    stage_credit_ledger_id: input.stageCreditLedger?.ledger_id ?? null,
    stage_credit_account_id: input.stageAccount?.account_id ?? null,
    evidence_pressure_ledger_id: input.evidencePressureLedger?.ledger_id ?? null,
    target_value_gate: input.valueGate,
    expected_gate_delta: input.receipt?.expected_gate_delta ?? input.queueItem?.reason ?? null,
    required_output_receipts: input.requiredReceipts,
    validation_commands: input.validationCommands,
    max_parallelism: maxParallelism,
    max_runtime_seconds: maxRuntimeSeconds,
    max_notional: 0,
    dedupe_key: input.dedupeKey,
    before_refs: selectedBeforeRefs(
      input.torghutConsumerEvidence,
      input.receipt,
      input.materialReceipt,
      input.stageAccount,
    ),
    after_refs: uniqueStrings([
      input.torghutConsumerEvidence.alpha_readiness_settlement_conveyor?.conveyor_id,
      input.torghutConsumerEvidence.alpha_repair_dividend_ledger?.ledger_id,
    ]),
    settlement_state: 'pending',
    reason_codes: input.reasonCodes,
    rollback_target: input.materialReceipt?.rollback_target ?? input.receipt?.rollback_target ?? ROLLBACK_TARGET,
  } satisfies RepairSlot
}

const handoff = (input: {
  status: RepairSlotEscrowStatus
  selectedSlot: RepairSlot | null
  reasonCodes: string[]
  requiredReceipts: string[]
  validationCommands: string[]
}): RepairSlotEscrow['scheduler_handoff'] => ({
  status: input.status,
  selected_slot_id: input.selectedSlot?.slot_id ?? null,
  selected_dedupe_key: input.selectedSlot?.dedupe_key ?? null,
  action_class: 'dispatch_repair',
  max_parallelism: input.selectedSlot?.max_parallelism ?? 0,
  max_runtime_seconds: input.selectedSlot?.max_runtime_seconds ?? null,
  max_notional: 0,
  required_receipts: input.requiredReceipts,
  validation_commands: input.validationCommands,
  reason_codes: input.reasonCodes,
  next_action:
    input.status === 'observe_only' || input.status === 'open'
      ? 'cite the selected repair slot before launching one zero-notional Torghut executable-alpha repair'
      : 'hold dispatch_repair until the blocked slot reason codes clear',
})

export const buildRepairSlotEscrow = (input: BuildRepairSlotEscrowInput): RepairSlotEscrow => {
  const mode = input.mode ?? resolveRepairSlotEscrowMode()
  const queueItem = topRepairQueueItem(input.torghutConsumerEvidence)
  const receipt = selectedExecutableAlphaReceipt(input.torghutConsumerEvidence)
  const materialReceipt = materialReceiptForSelectedRepair(input.materialReentryClearinghouse, receipt)
  const stageAccount = stageCreditAccount(input.stageCreditLedger)
  const valueGate = selectedValueGate(queueItem, receipt, input.torghutConsumerEvidence)
  const requiredReceipts = selectedRequiredReceipts(queueItem, receipt, materialReceipt)
  const validationCommands = selectedValidationCommands(receipt, materialReceipt)
  const dedupeKey = slotDedupeKey({
    torghutConsumerEvidence: input.torghutConsumerEvidence,
    queueItem,
    receipt,
    valueGate,
    validationCommands,
  })
  const noDeltaDebt = noDeltaDebtsForSlot({
    torghutConsumerEvidence: input.torghutConsumerEvidence,
    receipt,
    valueGate,
    dedupeKey,
  })
  const reasons = blockReasons({
    now: input.now,
    queueItem,
    torghutConsumerEvidence: input.torghutConsumerEvidence,
    receipt,
    materialReentryClearinghouse: input.materialReentryClearinghouse,
    materialReceipt,
    stageCreditLedger: input.stageCreditLedger,
    stageAccount,
    evidencePressureLedger: input.evidencePressureLedger,
    noDeltaDebt,
  })
  const selectedSlot =
    reasons.length === 0
      ? buildSlot({
          state: slotStateForMode(mode),
          reasonCodes: [],
          torghutConsumerEvidence: input.torghutConsumerEvidence,
          receipt,
          materialReceipt,
          stageCreditLedger: input.stageCreditLedger,
          stageAccount,
          evidencePressureLedger: input.evidencePressureLedger,
          queueItem,
          valueGate,
          dedupeKey,
          validationCommands,
          requiredReceipts,
        })
      : null
  const blockedSlot =
    reasons.length > 0
      ? buildSlot({
          state: 'blocked',
          reasonCodes: reasons,
          torghutConsumerEvidence: input.torghutConsumerEvidence,
          receipt,
          materialReceipt,
          stageCreditLedger: input.stageCreditLedger,
          stageAccount,
          evidencePressureLedger: input.evidencePressureLedger,
          queueItem,
          valueGate,
          dedupeKey,
          validationCommands,
          requiredReceipts,
        })
      : null
  const status: RepairSlotEscrowStatus = selectedSlot ? statusForMode(mode) : 'block'
  const schedulerHandoff = handoff({
    status,
    selectedSlot,
    reasonCodes: reasons,
    requiredReceipts,
    validationCommands,
  })

  return {
    schema_version: SCHEMA_VERSION,
    escrow_id: `repair-slot-escrow:${hashJson({
      namespace: input.namespace,
      status,
      slot: selectedSlot?.slot_id ?? blockedSlot?.slot_id ?? null,
      reasons,
    })}`,
    generated_at: input.now.toISOString(),
    fresh_until: freshUntilFor(input.now, [
      input.torghutConsumerEvidence.fresh_until,
      input.torghutConsumerEvidence.executable_alpha_repair_receipts?.fresh_until,
      receipt?.fresh_until,
      input.materialReentryClearinghouse?.fresh_until,
      materialReceipt?.fresh_until,
      input.stageCreditLedger?.fresh_until,
      input.evidencePressureLedger?.fresh_until,
    ]),
    namespace: input.namespace,
    mode,
    status,
    governing_design_refs: [REPAIR_SLOT_ESCROW_DESIGN_ARTIFACT, REPAIR_SLOT_ESCROW_TORGHUT_DESIGN_ARTIFACT],
    selected_slot_id: selectedSlot?.slot_id ?? null,
    slots: selectedSlot ? [selectedSlot] : [],
    blocked_slots: blockedSlot ? [blockedSlot] : [],
    no_delta_debt: noDeltaDebt,
    scheduler_handoff: schedulerHandoff,
    deployer_handoff: {
      ...schedulerHandoff,
      next_action:
        status === 'observe_only' || status === 'open'
          ? 'do not widen rollout from repair slot alone; verify PR, Argo, workload readiness, /ready, and Torghut settlement'
          : 'keep deploy widening and merge-ready held until repair slot blockers clear',
    },
    rollback_target: ROLLBACK_TARGET,
  }
}
