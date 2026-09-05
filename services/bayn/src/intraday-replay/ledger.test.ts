import { describe, expect, test } from 'bun:test'
import { Result } from 'effect'

import { OrderSide } from '../execution/contracts'
import { intradayMomentumExecutionModel } from '../strategy/intraday-momentum/protocol'
import type { IntradayReplayIocOutcome } from './execution'
import {
  applyReplayFill,
  applyReplayIoc,
  createReplayLedger,
  type EconomicReplayFill,
  type IntradayReplayLedger,
} from './ledger'

const feeMultiplierPpm = 1_000_000
const executionModel = intradayMomentumExecutionModel
type FilledOutcome = Extract<IntradayReplayIocOutcome, { readonly status: 'filled' }>
type CanceledOutcome = Extract<IntradayReplayIocOutcome, { readonly status: 'canceled' }>

const filledDefaults: FilledOutcome = {
  symbol: 'AMD',
  side: OrderSide.Buy,
  requestedQuantityMicros: '1000000',
  filledQuantityMicros: '1000000',
  snapshotId: 'a'.repeat(64),
  snapshotContentHash: 'b'.repeat(64),
  observedAt: '2026-09-04T13:35:30.000Z',
  limitPriceMicros: '100000000',
  submittedAt: '2026-09-04T13:35:20.000Z',
  status: 'filled',
  fillPriceMicros: '100000000',
  fillNotionalMicros: '100000000',
  unfilledRemainder: 'none',
}

const filled = (overrides: Partial<FilledOutcome> = {}): FilledOutcome => ({ ...filledDefaults, ...overrides })

const canceledDefaults: CanceledOutcome = {
  symbol: 'AMD',
  side: OrderSide.Buy,
  requestedQuantityMicros: '1000000',
  filledQuantityMicros: '0',
  snapshotId: 'a'.repeat(64),
  snapshotContentHash: 'b'.repeat(64),
  observedAt: '2026-09-04T13:35:30.000Z',
  limitPriceMicros: '100000000',
  submittedAt: '2026-09-04T13:35:20.000Z',
  status: 'canceled',
  reason: 'no-displayed-liquidity',
  unfilledRemainder: 'canceled',
}

const canceled = (overrides: Partial<CanceledOutcome> = {}): CanceledOutcome => ({ ...canceledDefaults, ...overrides })

const success = <A, E>(result: Result.Result<A, E>): A => Result.getOrThrow(result)
const freshLedger = (cashMicros = '1000000000'): IntradayReplayLedger => success(createReplayLedger(cashMicros))
const apply = (ledger: IntradayReplayLedger, outcome: IntradayReplayIocOutcome) =>
  applyReplayIoc(ledger, outcome, executionModel, feeMultiplierPpm)

describe('intraday replay ledger', () => {
  test.each([
    ['requestedQuantityMicros', '1500000'],
    ['filledQuantityMicros', '1500000'],
    ['fillPriceMicros', '0'],
    ['fillNotionalMicros', '0'],
  ])('preserves the archive outcome error field for %s', (field, value) => {
    expect(apply(freshLedger(), filled({ [field]: value }))).toMatchObject({
      _tag: 'Failure',
      failure: { _tag: 'InvalidIntradayReplayLedger', field: `outcome.${field}` },
    })
  })

  test('preserves vendor provenance while applying the same cash and fee accounting', () => {
    type VendorFill = EconomicReplayFill & { readonly provenanceHash: string }
    const entry: VendorFill = {
      symbol: 'AMD',
      side: 'buy',
      observedAt: filledDefaults.observedAt,
      quantityMicros: '1000000',
      priceMicros: '100000000',
      notionalMicros: '100000000',
      provenanceHash: 'c'.repeat(64),
    }
    const vendor = success(
      applyReplayFill(
        success(createReplayLedger<VendorFill>('1000000000')),
        entry,
        '1000000',
        executionModel,
        feeMultiplierPpm,
      ),
    )
    const archive = success(apply(freshLedger(), filled()))
    expect(vendor.cashMicros).toBe(archive.cashMicros)
    expect(vendor.executionFeesMicros).toBe(archive.executionFeesMicros)
    expect(vendor.positions).toEqual(archive.positions)
    expect(vendor.fills).toEqual([entry])
    expect(vendor.fills[0]).not.toHaveProperty('snapshotId')
  })

  test('carries a partial entry through a profitable close and aggregates fees', () => {
    const afterEntry = success(
      apply(
        freshLedger(),
        filled({ requestedQuantityMicros: '2000000', filledQuantityMicros: '1000000', unfilledRemainder: 'canceled' }),
      ),
    )
    expect(afterEntry).toMatchObject({
      cashMicros: '899990000',
      executionFeesMicros: '10000',
      netRealizedPnlAfterCostsMicros: null,
      positions: [{ symbol: 'AMD', quantityMicros: '1000000', costBasisMicros: '100000000' }],
      fills: [{ quantityMicros: '1000000', notionalMicros: '100000000' }],
    })

    const closed = success(
      apply(
        afterEntry,
        filled({
          side: OrderSide.Sell,
          fillPriceMicros: '101000000',
          fillNotionalMicros: '101000000',
        }),
      ),
    )
    expect(closed).toMatchObject({
      openingCashMicros: '1000000000',
      cashMicros: '1000970000',
      executionFeesMicros: '30000',
      netRealizedPnlAfterCostsMicros: '970000',
      positions: [],
    })
    expect(closed.fills).toHaveLength(2)
  })

  test('reports a realized loss after all session costs when the position is flat', () => {
    const afterEntry = success(apply(freshLedger(), filled()))
    const closed = success(
      apply(afterEntry, filled({ side: OrderSide.Sell, fillPriceMicros: '99000000', fillNotionalMicros: '99000000' })),
    )

    expect(closed).toMatchObject({
      cashMicros: '998970000',
      executionFeesMicros: '30000',
      netRealizedPnlAfterCostsMicros: '-1030000',
      positions: [],
    })
  })

  test('retains cost basis after a partial exit and charges only the session fee increment', () => {
    const opened = success(
      apply(
        freshLedger(),
        filled({
          requestedQuantityMicros: '3000000',
          filledQuantityMicros: '3000000',
          fillNotionalMicros: '300000000',
        }),
      ),
    )
    const partial = success(
      apply(
        opened,
        filled({
          side: OrderSide.Sell,
          requestedQuantityMicros: '3000000',
          fillPriceMicros: '101000000',
          fillNotionalMicros: '101000000',
          unfilledRemainder: 'canceled',
        }),
      ),
    )
    expect(partial).toMatchObject({
      cashMicros: '800970000',
      executionFeesMicros: '30000',
      netRealizedPnlAfterCostsMicros: null,
      positions: [{ symbol: 'AMD', quantityMicros: '2000000', costBasisMicros: '200000000' }],
    })
    const closed = success(
      apply(
        partial,
        filled({
          side: OrderSide.Sell,
          requestedQuantityMicros: '2000000',
          filledQuantityMicros: '2000000',
          fillPriceMicros: '99000000',
          fillNotionalMicros: '198000000',
        }),
      ),
    )
    expect(closed).toMatchObject({
      cashMicros: '998970000',
      executionFeesMicros: '30000',
      netRealizedPnlAfterCostsMicros: '-1030000',
      positions: [],
    })
  })

  test('treats a canceled IOC as an accounting no-op', () => {
    const ledger = freshLedger()
    const result = apply(ledger, canceled())

    expect(Result.getOrThrow(result)).toBe(ledger)
  })

  test('rejects an oversell without mutating the existing position', () => {
    const ledger = success(apply(freshLedger(), filled()))
    const result = apply(
      ledger,
      filled({
        side: OrderSide.Sell,
        requestedQuantityMicros: '2000000',
        filledQuantityMicros: '2000000',
        fillPriceMicros: '99000000',
        fillNotionalMicros: '198000000',
      }),
    )

    expect(Result.isFailure(result)).toBe(true)
    if (Result.isFailure(result)) {
      expect(result.failure).toMatchObject({
        _tag: 'IntradayReplayLedgerOversell',
        symbol: 'AMD',
        requestedQuantityMicros: '2000000',
        positionQuantityMicros: '1000000',
      })
    }
    expect(ledger.positions).toEqual([{ symbol: 'AMD', quantityMicros: '1000000', costBasisMicros: '100000000' }])
  })

  test('rejects a buy that only fits before the accrued session fee', () => {
    const result = apply(freshLedger('100000000'), filled())

    expect(Result.isFailure(result)).toBe(true)
    if (Result.isFailure(result)) {
      expect(result.failure).toMatchObject({
        _tag: 'IntradayReplayLedgerInsufficientCash',
        cashMicros: '100000000',
        requiredCashMicros: '100010000',
      })
    }
  })

  test('rejects malformed financial quantities and notional without recording a fill', () => {
    const ledger = freshLedger()
    const malformedNotional = apply(ledger, filled({ fillNotionalMicros: '99999999' }))
    const fractionalQuantity = apply(
      ledger,
      filled({ requestedQuantityMicros: '1500000', filledQuantityMicros: '1500000' }),
    )

    expect(Result.isFailure(malformedNotional)).toBe(true)
    expect(Result.isFailure(fractionalQuantity)).toBe(true)
    if (Result.isFailure(malformedNotional))
      expect(malformedNotional.failure).toMatchObject({ reason: 'notional-mismatch' })
    if (Result.isFailure(fractionalQuantity)) {
      expect(fractionalQuantity.failure).toMatchObject({ reason: 'non-whole-share-quantity' })
    }
    expect(ledger.fills).toEqual([])
  })

  test('bounds the fee multiplier before accounting', () => {
    const result = applyReplayIoc(freshLedger(), filled(), executionModel, 999_999)

    expect(Result.isFailure(result)).toBe(true)
    if (Result.isFailure(result)) expect(result.failure).toMatchObject({ reason: 'invalid-fee-multiplier' })
  })
})
