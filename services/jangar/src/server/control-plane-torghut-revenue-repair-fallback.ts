import type { TorghutConsumerEvidenceStatus } from '~/data/agents-control-plane'
import {
  readAlphaEvidenceFoundry,
  readAlphaRepairClosureBoard,
} from '~/server/control-plane-torghut-alpha-closure-evidence'
import {
  alphaClosureDividendSloSchemaMismatch,
  readAlphaClosureDividendSlo,
} from '~/server/control-plane-torghut-alpha-closure-dividend-slo'
import { readAlphaReadinessStrikeLedger } from '~/server/control-plane-torghut-alpha-readiness-strike'
import {
  alphaReadinessSettlementConveyorRefSchemaMismatch,
  readAlphaReadinessSettlementConveyorRef,
} from '~/server/control-plane-torghut-alpha-readiness-settlement-conveyor'
import {
  alphaRepairDividendLedgerRefSchemaMismatch,
  readAlphaRepairDividendLedgerRef,
} from '~/server/control-plane-torghut-alpha-repair-dividend-ledger'
import {
  noDeltaRepairReentryAuctionRefSchemaMismatch,
  readNoDeltaRepairReentryAuctionRef,
} from '~/server/control-plane-torghut-no-delta-repair-reentry-auction'
import { readExecutableAlphaRepairReceipts } from '~/server/control-plane-torghut-executable-alpha-repair'
import {
  hasRevenueRepairSummary,
  normalizeRevenueRepairBoolean,
  readRevenueRepairQueue,
} from '~/server/control-plane-torghut-revenue-repair'
import { normalizeNonEmpty, normalizeReason, uniqueStrings } from '~/server/control-plane-torghut-evidence-normalizers'

export const buildUnavailableStatusFromRevenueRepair = (input: {
  endpoint: string
  status: TorghutConsumerEvidenceStatus['status']
  reason: string
  message: string
  payload: Record<string, unknown> | null
}): TorghutConsumerEvidenceStatus => {
  const revenueRepairBusinessState = normalizeReason(input.payload?.business_state)
  const revenueRepairReady = normalizeRevenueRepairBoolean(input.payload?.revenue_ready)
  const revenueRepairQueue = readRevenueRepairQueue(input.payload)
  const alphaReadinessStrikeLedger = readAlphaReadinessStrikeLedger(input.payload)
  const executableAlphaRepairReceipts = readExecutableAlphaRepairReceipts(input.payload)
  const alphaRepairClosureBoard = readAlphaRepairClosureBoard(input.payload)
  const alphaEvidenceFoundry = readAlphaEvidenceFoundry(input.payload)
  const alphaReadinessSettlementConveyor = readAlphaReadinessSettlementConveyorRef(input.payload)
  const alphaRepairDividendLedger = readAlphaRepairDividendLedgerRef(input.payload)
  const alphaClosureDividendSlo = readAlphaClosureDividendSlo(input.payload)
  const noDeltaRepairReentryAuction = readNoDeltaRepairReentryAuctionRef(input.payload)
  const topRepairItem = revenueRepairQueue[0] ?? null
  const maxNotional = normalizeNonEmpty(input.payload?.max_notional) ?? topRepairItem?.max_notional ?? null
  const observedContracts = uniqueStrings([
    alphaReadinessStrikeLedger ? 'alpha_readiness_strike_ledger' : null,
    executableAlphaRepairReceipts ? 'executable_alpha_repair_receipts' : null,
    alphaRepairClosureBoard ? 'alpha_repair_closure_board' : null,
    alphaEvidenceFoundry ? 'alpha_evidence_foundry' : null,
    alphaReadinessSettlementConveyor ? 'alpha_readiness_settlement_conveyor' : null,
    alphaRepairDividendLedger ? 'alpha_repair_dividend_ledger' : null,
    alphaClosureDividendSlo ? 'alpha_closure_dividend_slo' : null,
    noDeltaRepairReentryAuction ? 'no_delta_repair_reentry_auction' : null,
  ])
  const contractSchemaMismatches = uniqueStrings([
    alphaReadinessSettlementConveyorRefSchemaMismatch(input.payload),
    alphaRepairDividendLedgerRefSchemaMismatch(input.payload),
    alphaClosureDividendSloSchemaMismatch(input.payload),
    noDeltaRepairReentryAuctionRefSchemaMismatch(input.payload),
  ])

  return {
    status: input.status,
    endpoint: input.endpoint,
    receipt_id: null,
    generated_at: null,
    fresh_until: null,
    candidate_id: null,
    dataset_snapshot_ref: null,
    max_notional: maxNotional,
    revenue_repair_business_state: revenueRepairBusinessState,
    revenue_repair_ready: revenueRepairReady,
    revenue_repair_queue: revenueRepairQueue,
    observed_contracts: observedContracts,
    contract_schema_mismatches: contractSchemaMismatches,
    alpha_readiness_strike_ledger: alphaReadinessStrikeLedger,
    executable_alpha_repair_receipts: executableAlphaRepairReceipts,
    alpha_repair_closure_board: alphaRepairClosureBoard,
    alpha_evidence_foundry: alphaEvidenceFoundry,
    alpha_readiness_settlement_conveyor: alphaReadinessSettlementConveyor,
    alpha_repair_dividend_ledger: alphaRepairDividendLedger,
    alpha_closure_dividend_slo: alphaClosureDividendSlo,
    no_delta_repair_reentry_auction: noDeltaRepairReentryAuction,
    reason_codes: [input.reason],
    message:
      input.payload && hasRevenueRepairSummary(input.payload)
        ? `${input.message}; revenue-repair source-of-truth fallback carried business topline`
        : input.message,
  }
}
