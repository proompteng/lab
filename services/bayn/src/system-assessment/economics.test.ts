import { describe, expect, test } from 'bun:test'
import { Result } from 'effect'
import fc from 'fast-check'

import { checkProperty } from '../testing/property-test-support'
import {
  advanceQualificationEquity,
  binaryTradeEdge,
  cashInventoryTradingPnl,
  markedRisk,
  netTradingPnl,
} from './economics'
import { makeOperatingCostReport, OperatingCostCategory, OperatingCostCoverage } from '../operating-costs'
import { operatingCostFixture, type OperatingAmountsFixture } from '../operating-costs.test-support'

const amounts = (override: Partial<OperatingAmountsFixture> = {}): OperatingAmountsFixture => ({
  netTradingPnlMicros: '900000',
  inferenceInvoiceMicros: '50000',
  inferenceTariffMicros: '70000',
  dataCostMicros: '20000',
  infrastructureCostMicros: '30000',
  researchCostMicros: '40000',
  ...override,
})
const report = (amounts: OperatingAmountsFixture) => {
  const fixture = operatingCostFixture(amounts)
  return makeOperatingCostReport(fixture.inference, fixture.evidence, fixture.verifiedSources)
}

describe('system economics', () => {
  test('deducts actual operating costs once and separates the conservative qualification amount', () => {
    expect(Result.getOrThrow(report(amounts()))).toMatchObject({
      netTradingPnlMicros: '900000',
      totalOperatingCostMicros: '140000',
      netEconomicPnlMicros: '760000',
      qualificationInferenceCostMicros: '70000',
      qualificationPnlMicros: '740000',
    })
  })

  test('positive trading profit can be an economic loss and zero trades can still lose money', () => {
    expect(Result.getOrThrow(report(amounts({ infrastructureCostMicros: '1000000' }))).netEconomicPnlMicros).toBe(
      '-210000',
    )
    expect(Result.getOrThrow(report(amounts({ netTradingPnlMicros: '0' }))).netEconomicPnlMicros).toBe('-140000')
  })

  test('external funding and passive yield do not supply trading profit', () => {
    expect(
      cashInventoryTradingPnl({
        openingEquityMicros: '1000000',
        closingEquityMicros: '7400000',
        netExternalFlowsMicros: '5000000',
        passiveCashYieldMicros: '1000000',
        operatingCostsPaidFromAccountMicros: '0',
      }),
    ).toBe('400000')
  })

  test('does not silently replace missing or negative costs with zero', () => {
    const fixture = operatingCostFixture(amounts())
    const incomplete = Result.getOrThrow(
      makeOperatingCostReport(
        fixture.inference,
        {
          ...fixture.evidence,
          coverage: fixture.evidence.coverage.map((coverage) =>
            coverage.category === OperatingCostCategory.Data
              ? { ...coverage, status: OperatingCostCoverage.Unknown, sourceHash: null }
              : coverage,
          ),
        },
        fixture.verifiedSources,
      ),
    )
    expect(incomplete.netEconomicPnlMicros).toBeNull()
    expect(incomplete.qualificationPnlMicros).toBeNull()
    expect(Result.isFailure(report(amounts({ inferenceInvoiceMicros: '-1' })))).toBe(true)
  })

  test('an operating expense paid from broker cash is deducted once, just like the same expense paid outside it', () => {
    const cash = {
      openingEquityMicros: '1000000',
      closingEquityMicros: '1900000',
      netExternalFlowsMicros: '0',
      passiveCashYieldMicros: '0',
      operatingCostsPaidFromAccountMicros: '0',
    }
    const outside = cashInventoryTradingPnl(cash)
    const inside = cashInventoryTradingPnl({
      ...cash,
      closingEquityMicros: '1760000',
      operatingCostsPaidFromAccountMicros: '140000',
    })
    expect(inside).toBe(outside)
    const economic = Result.getOrThrow(report(amounts({ netTradingPnlMicros: inside })))
    expect(economic.netEconomicPnlMicros).toBe('760000')
    expect(economic.qualificationPnlMicros).toBe('740000')
  })

  test('cash and marked inventory reproduce trading profit independently of operating expense payment', () => {
    const trading = netTradingPnl({
      grossRealizedPnlMicros: '200',
      openingUnrealizedPnlMicros: '-50',
      closingUnrealizedPnlMicros: '30',
      executionCostMicros: '20',
      cashSettlementRoundingMicros: '-1',
    })
    expect(trading).toBe(259n)
    expect(
      cashInventoryTradingPnl({
        openingEquityMicros: '1000',
        closingEquityMicros: '1639',
        netExternalFlowsMicros: '400',
        passiveCashYieldMicros: '10',
        operatingCostsPaidFromAccountMicros: '30',
      }),
    ).toBe(trading.toString())
  })

  test('session aggregation retains losing periods and cannot recover a missing total', () => {
    expect([10n, -30n, 0n, 40n].reduce<bigint | null>(advanceQualificationEquity, 100n)).toBe(120n)
    expect([10n, null, -30n, 40n].reduce<bigint | null>(advanceQualificationEquity, 100n)).toBeNull()
  })

  test('an attractive target ratio can have negative expected edge', () => {
    const edge = Result.getOrThrow(
      binaryTradeEdge({
        gainMicros: 2_000_000n,
        lossMicros: 1_000_000n,
        costMicros: 100_000n,
        winProbabilityNumerator: 3n,
        winProbabilityDenominator: 10n,
      }),
    )
    expect(edge.expectedNetMicros).toEqual({ numerator: '-2000000', denominator: '10' })
    expect(edge.positive).toBe(false)
    expect(edge.breakEvenWinProbability).toEqual({ numerator: '1100000', denominator: '3000000' })
  })

  test('drawdown carries prior peaks and session loss uses the opening mark', () => {
    expect(markedRisk([100n, 120n, 110n, 90n, 105n])).toEqual({
      maximumDrawdownMicros: '30',
      maximumSessionLossMicros: '10',
    })
  })

  test('property: qualification profit cannot exceed actual profit and increasing costs cannot improve either', () => {
    checkProperty(
      'system-economic-monotonicity',
      fc.property(
        fc.bigInt({ min: 0n, max: 10n ** 20n }),
        fc.bigInt({ min: 0n, max: 10n ** 20n }),
        fc.bigInt({ min: 0n, max: 10n ** 20n }),
        (invoice, tariff, extra) => {
          const base = amounts({ inferenceInvoiceMicros: invoice.toString(), inferenceTariffMicros: tariff.toString() })
          const a = Result.getOrThrow(report(base))
          const b = Result.getOrThrow(
            report({
              ...base,
              researchCostMicros: (BigInt(base.researchCostMicros) + extra).toString(),
            }),
          )
          if (
            a.qualificationPnlMicros === null ||
            a.netEconomicPnlMicros === null ||
            b.qualificationPnlMicros === null ||
            b.netEconomicPnlMicros === null
          )
            throw new Error('Complete source fixture must produce economic totals')
          expect(BigInt(a.qualificationPnlMicros) <= BigInt(a.netEconomicPnlMicros)).toBe(true)
          expect(BigInt(b.netEconomicPnlMicros)).toBe(BigInt(a.netEconomicPnlMicros) - extra)
          expect(BigInt(b.qualificationPnlMicros)).toBe(BigInt(a.qualificationPnlMicros) - extra)
        },
      ),
    )
  })
})
