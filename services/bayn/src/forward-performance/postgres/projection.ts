import type { ForwardPerformanceExecutionEvidence, ForwardPerformanceMarketVolumeRequest } from '../model'
import { legacyExecutionAuthorityToken } from '../../execution/legacy-wire'
import {
  CycleDecisionRow,
  FillExecutionRow,
  IntentExecutionRow,
  MarketVolumeBindingRow,
  OrderExecutionRow,
} from './model'

export const uniqueRows = <Row>(rows: readonly Row[], key: (row: Row) => string): ReadonlyMap<string, Row | null> => {
  const byKey = new Map<string, Row | null>()
  for (const row of rows) {
    const identity = key(row)
    byKey.set(identity, byKey.has(identity) ? null : row)
  }
  return byKey
}

export const intentExecutionKey = (input: {
  readonly cycleId: string
  readonly decisionHash: string
  readonly accountId: string
  readonly symbol: string
  readonly side: 'BUY' | 'SELL'
  readonly quantityMicros: string
  readonly replanGenerationHash?: string
  readonly createdAt: string
}): string =>
  JSON.stringify([
    input.cycleId,
    input.decisionHash,
    input.accountId,
    input.symbol,
    input.side,
    input.quantityMicros,
    input.replanGenerationHash ?? null,
    input.createdAt,
  ])

export const executionEvidenceFromRows = (
  decisionRows: readonly (typeof CycleDecisionRow.Type)[],
  intentRows: readonly (typeof IntentExecutionRow.Type)[],
  orderRows: readonly (typeof OrderExecutionRow.Type)[],
  fillRows: readonly (typeof FillExecutionRow.Type)[],
): readonly ForwardPerformanceExecutionEvidence[] => {
  const intents = uniqueRows(intentRows, (row) =>
    intentExecutionKey({
      cycleId: row.cycle_id,
      decisionHash: row.decision_hash,
      accountId: row.account_id,
      symbol: row.symbol,
      side: row.side,
      quantityMicros: row.quantity_micros,
      ...(row.replan_generation_hash === null ? {} : { replanGenerationHash: row.replan_generation_hash }),
      createdAt: row.created_at.toISOString(),
    }),
  )
  const orders = uniqueRows(orderRows, (row) => row.intent_id)
  const fills = new Map<string, (typeof FillExecutionRow.Type)[]>()
  for (const row of fillRows) {
    const found = fills.get(row.intent_id)
    if (found === undefined) fills.set(row.intent_id, [row])
    else found.push(row)
  }

  const evidence: ForwardPerformanceExecutionEvidence[] = []
  for (const row of decisionRows) {
    const document = row.document
    if (document.targetPlan.status !== 'PLANNED') continue
    const replanGenerationHash =
      document.mode === legacyExecutionAuthorityToken ? document.replanGenerationHash : undefined
    for (const target of document.targetPlan.intentTargets) {
      const matchingReferences = document.targetPlan.targets.filter((candidate) => candidate.symbol === target.symbol)
      const reference = matchingReferences.length === 1 ? matchingReferences[0] : undefined
      const intentRow = intents.get(
        intentExecutionKey({
          cycleId: row.cycle_id,
          decisionHash: document.bindings.strategyDecisionHash,
          accountId: document.bindings.accountId,
          symbol: target.symbol,
          side: target.side,
          quantityMicros: target.quantityMicros,
          ...(replanGenerationHash === undefined ? {} : { replanGenerationHash }),
          createdAt: document.createdAt,
        }),
      )
      const intentId = intentRow === undefined || intentRow === null ? '' : intentRow.intent_id
      const orderRow = orders.get(intentId)
      const fillEvidence = (fills.get(intentId) ?? []).map((fill) => ({
        brokerEventId: fill.event_id,
        fillId: fill.fill_id,
        brokerOrderId: fill.broker_order_id,
        clientOrderId: fill.client_order_id,
        intentId: fill.intent_id,
        accountId: fill.account_id,
        symbol: fill.symbol,
        side: fill.side,
        quantityMicros: fill.quantity_micros,
        priceMicros: fill.price_micros,
        feeMicros: fill.fee_micros,
        sourceTimestamp: fill.source_timestamp,
        occurredAt: fill.occurred_at.toISOString(),
        observedAt: fill.observed_at.toISOString(),
      }))
      evidence.push({
        cycleId: row.cycle_id,
        decisionDocumentHash:
          row.decision_hash === document.contentHash &&
          document.bindings.cycleId === row.cycle_id &&
          document.createdAt === row.created_at.toISOString()
            ? document.contentHash
            : '',
        decisionHash: document.bindings.strategyDecisionHash,
        decisionCreatedAt: document.createdAt,
        intentId,
        accountId: document.bindings.accountId,
        symbol: target.symbol,
        side: target.side,
        plannedQuantityMicros: target.quantityMicros,
        ...(reference === undefined ? {} : { referencePriceMicros: reference.referencePriceMicros }),
        ...(intentRow === undefined || intentRow === null || intentRow.terminal_outcome === null
          ? {}
          : {
              intent: {
                intentId: intentRow.intent_id,
                accountId: intentRow.account_id,
                clientOrderId: intentRow.client_order_id,
                cycleId: intentRow.cycle_id,
                decisionHash: intentRow.decision_hash,
                symbol: intentRow.symbol,
                side: intentRow.side,
                quantityMicros: intentRow.quantity_micros,
                notionalLimitMicros: intentRow.notional_limit_micros,
                terminalOutcome: intentRow.terminal_outcome,
                createdAt: intentRow.created_at.toISOString(),
                updatedAt: intentRow.updated_at.toISOString(),
              },
            }),
        ...(orderRow === undefined || orderRow === null
          ? {}
          : {
              terminalOrder: {
                eventId: orderRow.event_id,
                brokerOrderId: orderRow.broker_order_id,
                clientOrderId: orderRow.client_order_id,
                intentId: orderRow.intent_id,
                accountId: orderRow.account_id,
                symbol: orderRow.symbol,
                side: orderRow.side,
                ...(orderRow.quantity_micros === null ? {} : { quantityMicros: orderRow.quantity_micros }),
                ...(orderRow.notional_micros === null ? {} : { notionalMicros: orderRow.notional_micros }),
                filledQuantityMicros: orderRow.filled_quantity_micros,
                status: orderRow.status,
                occurredAt: orderRow.occurred_at.toISOString(),
                observedAt: orderRow.observed_at.toISOString(),
              },
            }),
        fills: fillEvidence,
      })
    }
  }
  return evidence
}

export const marketVolumeRequestsFromRows = (
  executionEvidence: readonly ForwardPerformanceExecutionEvidence[],
  bindingRows: readonly (typeof MarketVolumeBindingRow.Type)[],
  evidenceCutoffAt: string | undefined,
): readonly ForwardPerformanceMarketVolumeRequest[] => {
  if (evidenceCutoffAt === undefined) return []
  const bindings = uniqueRows(bindingRows, (row) => row.cycle_id)
  const requests = new Map<string, ForwardPerformanceMarketVolumeRequest>()
  for (const execution of executionEvidence) {
    const binding = bindings.get(execution.cycleId)
    if (
      binding === undefined ||
      binding === null ||
      binding.snapshot_id !== binding.manifest.snapshotId ||
      !binding.manifest.symbols.includes(execution.symbol)
    ) {
      continue
    }
    const request: ForwardPerformanceMarketVolumeRequest = {
      cycleId: execution.cycleId,
      decisionSnapshotId: binding.snapshot_id,
      decisionSnapshotAsOfSession: binding.manifest.asOfSession,
      symbol: execution.symbol,
      executionSessionDate: binding.execution_session_date,
      windowOpenedAt: binding.execution_open_at.toISOString(),
      windowClosedAt: binding.execution_close_at.toISOString(),
      evidenceCutoffAt,
      universeId: binding.manifest.universeId,
      universeSymbolHash: binding.manifest.universeSymbolHash,
      symbols: binding.manifest.symbols,
      requestedStart: binding.manifest.requestedStart,
      calendarVersion: binding.manifest.calendarVersion,
      source: binding.manifest.source,
      sourceFeed: binding.manifest.sourceFeed,
      adjustment: binding.manifest.adjustment,
    }
    requests.set(JSON.stringify([request.cycleId, request.symbol]), request)
  }
  return [...requests.values()].sort((left, right) => {
    const leftKey = JSON.stringify([left.executionSessionDate, left.cycleId, left.symbol])
    const rightKey = JSON.stringify([right.executionSessionDate, right.cycleId, right.symbol])
    return leftKey < rightKey ? -1 : leftKey > rightKey ? 1 : 0
  })
}
