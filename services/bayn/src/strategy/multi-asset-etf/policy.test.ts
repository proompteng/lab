import { describe, expect, test } from 'bun:test'
import { Result, Schema } from 'effect'
import fc from 'fast-check'

import { canonicalHashV1Result } from '../../hash'
import {
  decodeMultiAssetEtfPolicy,
  MultiAssetEtfPolicySchema,
  defaultMultiAssetEtfPolicy,
  makeMultiAssetEtfPolicy,
  multiAssetEtfs,
  sleeveNames,
} from './policy'

const policy = Result.getOrThrow(defaultMultiAssetEtfPolicy())
const { policyHash, ...material } = policy

describe('multi-asset ETF policy', () => {
  test('pins the canonical default identity and exact universe with no idle cash sweep', () => {
    expect(policyHash).toBe('3b372dc32c7441f8659cac4b48bd021c0fe965b54d9a1d45ecc6029ba380503a')
    expect(multiAssetEtfs).toEqual([
      'SPY',
      'QQQ',
      'IWM',
      'DIA',
      'XLK',
      'XLF',
      'XLE',
      'XLV',
      'XLI',
      'XLP',
      'XLU',
      'XLY',
      'XLB',
      'XLC',
      'XLRE',
      'TLT',
      'IEF',
      'SHY',
      'HYG',
      'LQD',
      'GLD',
      'SLV',
      'DBC',
      'USO',
      'UUP',
      'EFA',
      'EEM',
    ])
    expect(policy.idleCashSweep).toEqual({ enabled: false })
    const reordered = Object.fromEntries(Object.entries(policy).reverse())
    const decoded = Result.getOrThrow(decodeMultiAssetEtfPolicy(JSON.parse(JSON.stringify(reordered))))
    expect(decoded).toEqual(policy)
    expect(Object.isFrozen(decoded)).toBe(true)
    expect(Object.isFrozen(decoded.risk)).toBe(true)
    expect(Object.isFrozen(decoded.universe)).toBe(true)
    expect(Object.isFrozen(decoded.sleeves.rotation.riskOnSymbols)).toBe(true)
    expect(Object.isFrozen(decoded.sleeves.rotation)).toBe(true)
    const wire = structuredClone(policy)
    const fromSchema = Schema.decodeUnknownSync(MultiAssetEtfPolicySchema)(wire)
    expect(Object.isFrozen(fromSchema.sleeves.rotation.riskOnSymbols)).toBe(true)
    expect(Object.isFrozen(wire.sleeves.rotation.riskOnSymbols)).toBe(false)
    expect(Result.isFailure(decodeMultiAssetEtfPolicy({ ...wire, unknown: true }))).toBe(true)
  })

  test('rejects tampered and malformed policy material even when rehashed', () => {
    expect(Result.isFailure(decodeMultiAssetEtfPolicy({ ...policy, historyStartSession: '2017-01-03' }))).toBe(true)
    const invalid = [
      { ...material, universe: [...multiAssetEtfs.slice(1), 'SPY'] },
      { ...material, universe: [...multiAssetEtfs.slice(0, -1), 'SPY'] },
      { ...material, sleeves: { ...material.sleeves, trend: { ...material.sleeves.trend, momentumSessions: 119 } } },
      { ...material, sleeves: { ...material.sleeves, trend: { ...material.sleeves.trend, capitalWeight: 0.2001 } } },
      { ...material, sleeves: { ...material.sleeves, trend: { ...material.sleeves.trend, capitalWeight: -0.01 } } },
      { ...material, idleCashSweep: { enabled: false, symbol: 'SGOV' } },
      { ...material, idleCashSweep: { enabled: true, symbol: 'TLT' } },
      { ...material, risk: { ...material.risk, maxGrossLeverage: 0.1 } },
      { ...material, risk: { ...material.risk, minRebalanceDriftBps: -1 } },
      { ...material, risk: { ...material.risk, entryLimitCollarBps: 0 } },
    ]
    for (const input of invalid) {
      expect(
        Result.isFailure(
          decodeMultiAssetEtfPolicy({ ...input, policyHash: Result.getOrThrow(canonicalHashV1Result(input)) }),
        ),
      ).toBe(true)
    }
  })

  test('property: exact capital budget and canonical identity are independent of field order', () => {
    fc.assert(
      fc.property(fc.tuple(...sleeveNames.map(() => fc.integer({ min: 0, max: 4_000 }))), (weights) => {
        const sleeves = { ...material.sleeves }
        for (const [i, name] of sleeveNames.entries()) {
          Object.assign(sleeves, { [name]: { ...sleeves[name], capitalWeight: weights[i] / 10_000 } })
        }
        const result = makeMultiAssetEtfPolicy({ ...material, sleeves })
        if (weights.reduce((sum, weight) => sum + weight, 0) > 10_000) expect(Result.isFailure(result)).toBe(true)
        else {
          const built = Result.getOrThrow(result)
          const reordered = { ...built, sleeves: Object.fromEntries(Object.entries(sleeves).reverse()) }
          expect(Result.getOrThrow(decodeMultiAssetEtfPolicy(reordered)).policyHash).toBe(built.policyHash)
        }
      }),
      { seed: 420401 },
    )
    expect(
      Result.getOrThrow(makeMultiAssetEtfPolicy({ ...material, idleCashSweep: { enabled: true, symbol: 'SGOV' } }))
        .policyHash,
    ).not.toBe(policyHash)
  })
})
