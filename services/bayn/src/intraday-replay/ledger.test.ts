import { describe, expect, test } from 'bun:test'
import { Result } from 'effect'

import { intradayMomentumExecutionModel } from '../strategy/intraday-momentum/protocol'
import { applyReplayFill, createReplayLedger, type EconomicReplayFill, type ReplayLedger } from './ledger'

const feeMultiplierPpm = 1_000_000
const executionModel = intradayMomentumExecutionModel
type FillInput = EconomicReplayFill & { readonly requestedQuantityMicros: string }
const filledDefaults: FillInput = {
  symbol: 'AMD',
  side: 'buy',
  requestedQuantityMicros: '1000000',
  quantityMicros: '1000000',
  observedAt: '2026-09-04T13:35:30.000Z',
  priceMicros: '100000000',
  notionalMicros: '100000000',
}
const filled = (overrides: Partial<FillInput> = {}): FillInput => ({ ...filledDefaults, ...overrides })
const success = <A, E>(result: Result.Result<A, E>): A => Result.getOrThrow(result)
const freshLedger = (cashMicros = '1000000000') => success(createReplayLedger(cashMicros))
const apply = (ledger: ReplayLedger<EconomicReplayFill>, input: FillInput) => {
  const { requestedQuantityMicros, ...fill } = input
  return applyReplayFill(ledger, fill, requestedQuantityMicros, executionModel, feeMultiplierPpm)
}

describe('intraday replay ledger', () => {
  test('rounds each session independently while carrying cash positions and prior fees', () => {
    const firstEntry = success(apply(freshLedger(), filled()))
    const firstClose = success(apply(firstEntry, filled({ side: 'sell' })))
    const secondEntry = success(apply(firstClose, filled({ observedAt: '2026-09-08T13:35:30.000Z' })))
    const secondClose = success(apply(secondEntry, filled({ side: 'sell', observedAt: '2026-09-08T19:55:30.000Z' })))
    expect(firstClose.executionFeesMicros).toBe('30000')
    expect(secondEntry.executionFeesMicros).toBe('40000')
    expect(secondClose.executionFeesMicros).toBe('60000')
    expect(secondClose.cashMicros).toBe('999940000')
    expect(secondClose.netRealizedPnlAfterCostsMicros).toBe('-60000')
    expect(secondClose.fills).toHaveLength(4)
    expect(secondClose.positions).toEqual([])
  })

  test.each([
    ['requestedQuantityMicros', '1.5'],
    ['quantityMicros', '1.5'],
    ['priceMicros', '0'],
    ['observedAt', 'invalid-date'],
    ['notionalMicros', '0'],
  ])('rejects malformed fill data in %s', (field, value) => {
    expect(apply(freshLedger(), filled({ [field]: value }))).toMatchObject({
      _tag: 'Failure',
      failure: {
        _tag: 'InvalidIntradayReplayLedger',
        field: field === 'requestedQuantityMicros' ? field : `fill.${field}`,
      },
    })
  })

  test('retains fill provenance through cash and fee accounting', () => {
    type ProvenancedFill = EconomicReplayFill & { readonly provenanceHash: string }
    const entry: ProvenancedFill = {
      symbol: 'AMD',
      side: 'buy',
      observedAt: filledDefaults.observedAt,
      quantityMicros: '1000000',
      priceMicros: '100000000',
      notionalMicros: '100000000',
      provenanceHash: 'c'.repeat(64),
    }
    const ledger = success(
      applyReplayFill(
        success(createReplayLedger<ProvenancedFill>('1000000000')),
        entry,
        '1000000',
        executionModel,
        feeMultiplierPpm,
      ),
    )
    const reference = success(apply(freshLedger(), filled()))
    expect(ledger.cashMicros).toBe(reference.cashMicros)
    expect(ledger.executionFeesMicros).toBe(reference.executionFeesMicros)
    expect(ledger.positions).toEqual(reference.positions)
    expect(ledger.fills).toEqual([entry])
    expect(ledger.fills[0]).not.toHaveProperty('snapshotId')
  })

  test('carries a partial entry through a profitable close and aggregates fees', () => {
    const afterEntry = success(
      apply(freshLedger(), filled({ requestedQuantityMicros: '2000000', quantityMicros: '1000000' })),
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
          side: 'sell',
          priceMicros: '101000000',
          notionalMicros: '101000000',
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
      apply(afterEntry, filled({ side: 'sell', priceMicros: '99000000', notionalMicros: '99000000' })),
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
          quantityMicros: '3000000',
          notionalMicros: '300000000',
        }),
      ),
    )
    const partial = success(
      apply(
        opened,
        filled({
          side: 'sell',
          requestedQuantityMicros: '3000000',
          priceMicros: '101000000',
          notionalMicros: '101000000',
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
          side: 'sell',
          requestedQuantityMicros: '2000000',
          quantityMicros: '2000000',
          priceMicros: '99000000',
          notionalMicros: '198000000',
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

  test('rejects an oversell without mutating the existing position', () => {
    const ledger = success(apply(freshLedger(), filled()))
    const result = apply(
      ledger,
      filled({
        side: 'sell',
        requestedQuantityMicros: '2000000',
        quantityMicros: '2000000',
        priceMicros: '99000000',
        notionalMicros: '198000000',
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
    const malformedNotional = apply(ledger, filled({ notionalMicros: '99999999' }))
    const fractionalQuantity = apply(ledger, filled({ requestedQuantityMicros: '1500000', quantityMicros: '1500000' }))

    expect(Result.isFailure(malformedNotional)).toBe(true)
    expect(Result.isFailure(fractionalQuantity)).toBe(true)
    if (Result.isFailure(malformedNotional))
      expect(malformedNotional.failure).toMatchObject({ reason: 'notional-mismatch' })
    if (Result.isFailure(fractionalQuantity)) {
      expect(fractionalQuantity.failure).toMatchObject({ reason: 'notional-mismatch' })
    }
    expect(ledger.fills).toEqual([])
  })

  test('accounts for fractional closes without changing quantity or rounding away residual shares', () => {
    const opened = success(
      apply(
        freshLedger(),
        filled({ quantityMicros: '2000000', requestedQuantityMicros: '2000000', notionalMicros: '200000000' }),
      ),
    )
    const partial = success(
      apply(
        opened,
        filled({
          side: 'sell',
          quantityMicros: '500000',
          requestedQuantityMicros: '500000',
          notionalMicros: '50000000',
        }),
      ),
    )
    expect(partial.positions[0]?.quantityMicros).toBe('1500000')
    const closed = success(
      apply(
        partial,
        filled({
          side: 'sell',
          quantityMicros: '1500000',
          requestedQuantityMicros: '1500000',
          notionalMicros: '150000000',
        }),
      ),
    )
    expect(closed.positions).toEqual([])
    expect(BigInt(closed.cashMicros) + BigInt(closed.executionFeesMicros)).toBe(1000000000n)
  })

  test('bounds the fee multiplier before accounting', () => {
    const result = applyReplayFill(freshLedger(), filled(), '1000000', executionModel, 999_999)

    expect(Result.isFailure(result)).toBe(true)
    if (Result.isFailure(result)) expect(result.failure).toMatchObject({ reason: 'invalid-fee-multiplier' })
  })
})
