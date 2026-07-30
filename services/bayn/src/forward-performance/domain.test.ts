import assert from 'node:assert/strict'

import { describe, expect, test } from 'bun:test'
import { Result } from 'effect'

import { makeForwardPerformanceReceipt } from './domain'
import type { ForwardPerformanceEvidenceInput, ForwardPerformanceReceipt } from './model'

const hash = (character: string): string => character.repeat(64)

const cycle = (name: string, overrides: Partial<ForwardPerformanceEvidenceInput['cycles'][number]> = {}) => ({
  cycleId: hash(name),
  qualificationRunId: hash('1'),
  strategyName: 'risk-balanced-trend',
  strategyProtocolHash: hash('2'),
  accountId: 'paper-account-1',
  executionPolicyHash: hash('3'),
  strategyExecutionModelHash: hash('4'),
  state: 'COMPLETED' as const,
  submissionOpenAt: '2026-07-20T13:00:00.000Z',
  terminalAt: '2026-07-20T21:00:00.000Z',
  ...overrides,
})

const transaction = (
  name: string,
  realizedPnlMicros: string,
  feeMicros: string,
  overrides: Partial<ForwardPerformanceEvidenceInput['transactions'][number]> = {},
) => ({
  transactionId: hash(name),
  cycleId: hash('a'),
  side: 'SELL' as const,
  feeMicros,
  realizedPnlMicros,
  occurredAt: '2026-07-20T20:00:00.000Z',
  ...overrides,
})

const input = (overrides: Partial<ForwardPerformanceEvidenceInput> = {}): ForwardPerformanceEvidenceInput => ({
  runtime: {
    sourceRevision: 'a'.repeat(40),
    imageRepository: 'registry.example.test/lab/bayn',
    imageDigest: `sha256:${hash('b')}`,
  },
  account: {
    accountId: 'paper-account-1',
    accountReferenceHash: hash('5'),
    provider: 'alpaca',
    environment: 'sandbox',
  },
  durableExecutionBindings: [
    {
      accountId: 'paper-account-1',
      accountReferenceHash: hash('5'),
      provider: 'alpaca',
      environment: 'sandbox',
      qualificationRunId: hash('1'),
      strategyName: 'risk-balanced-trend',
      strategyProtocolHash: hash('2'),
      strategyBehaviorHash: hash('6'),
      strategyParameterHash: hash('7'),
      strategyParameterSchemaVersion: 'bayn.risk-balanced-trend.protocol.v4',
      executionPolicyHash: hash('3'),
      sourceRevision: 'c'.repeat(40),
      imageRepository: 'registry.example.test/lab/bayn',
      imageDigest: `sha256:${hash('d')}`,
    },
  ],
  cycles: [cycle('a')],
  strategy: {
    qualificationRunId: hash('1'),
    strategyName: 'risk-balanced-trend',
    strategyProtocolHash: hash('2'),
    strategyBehaviorHash: hash('6'),
    strategyParameterHash: hash('7'),
    strategyParameterSchemaVersion: 'bayn.risk-balanced-trend.protocol.v4',
    sourceRevision: 'c'.repeat(40),
    imageRepository: 'registry.example.test/lab/bayn',
    imageDigest: `sha256:${hash('d')}`,
  },
  reconciliation: {
    reconciliationId: hash('8'),
    contentHash: hash('9'),
    status: 'EXACT',
    reconciledAt: '2026-07-20T21:01:00.000Z',
  },
  startingCapitalMicros: '1000',
  transactions: [transaction('e', '100', '20')],
  ledgerTotals: {
    realizedGainMicros: '100',
    realizedLossMicros: '0',
    brokerExecutionFeesMicros: '20',
    otherChargedCostsMicros: '0',
    cashYieldMicros: '0',
  },
  accountingReceiptsExact: true,
  ledgerExact: true,
  missingLedgerAccountCount: 0,
  unresolvedMutationCount: 0,
  unclosedCycleCount: 0,
  openPositionCount: 0,
  ...overrides,
})

const success = (value: Result.Result<ForwardPerformanceReceipt, unknown>): ForwardPerformanceReceipt => {
  assert(Result.isSuccess(value), 'forward-performance fixture must produce a receipt')
  return value.success
}

describe('forward performance domain', () => {
  test('reports positive net realized returns after charged costs', () => {
    const receipt = success(makeForwardPerformanceReceipt(input()))

    expect(receipt.evidence).toEqual({ status: 'SUFFICIENT', reasonCodes: [] })
    expect(receipt.profitability).toBe('PROFITABLE')
    expect(receipt.totals).toMatchObject({
      grossRealizedPnlMicros: '100',
      netRealizedPnlAfterCostsMicros: '80',
      netRealizedReturn: {
        numeratorMicros: '80',
        denominatorMicros: '1000',
        decimal: '0.080000000000',
      },
    })
  })

  test('reports realized losses without using mark-to-market equity', () => {
    const receipt = success(
      makeForwardPerformanceReceipt(
        input({
          transactions: [transaction('e', '-50', '10')],
          ledgerTotals: {
            realizedGainMicros: '0',
            realizedLossMicros: '50',
            brokerExecutionFeesMicros: '10',
            otherChargedCostsMicros: '0',
            cashYieldMicros: '0',
          },
        }),
      ),
    )

    expect(receipt.profitability).toBe('NOT_PROFITABLE')
    expect(receipt.totals.grossRealizedPnlMicros).toBe('-50')
    expect(receipt.totals.netRealizedPnlAfterCostsMicros).toBe('-60')
  })

  test('fees can flip gross profit into a net realized loss', () => {
    const receipt = success(
      makeForwardPerformanceReceipt(
        input({
          transactions: [transaction('e', '100', '150')],
          ledgerTotals: {
            realizedGainMicros: '100',
            realizedLossMicros: '0',
            brokerExecutionFeesMicros: '150',
            otherChargedCostsMicros: '0',
            cashYieldMicros: '0',
          },
        }),
      ),
    )

    expect(receipt.profitability).toBe('NOT_PROFITABLE')
    expect(receipt.totals.grossRealizedPnlMicros).toBe('100')
    expect(receipt.totals.netRealizedPnlAfterCostsMicros).toBe('-50')
  })

  test('an open or partial operating window is insufficient evidence', () => {
    const receipt = success(makeForwardPerformanceReceipt(input({ unclosedCycleCount: 1 })))

    expect(receipt.evidence).toEqual({ status: 'INSUFFICIENT_EVIDENCE', reasonCodes: ['UNCLOSED_WINDOW'] })
    expect(receipt.profitability).toBe('UNDETERMINED')
  })

  test('zero activity is never profitable', () => {
    const receipt = success(
      makeForwardPerformanceReceipt(
        input({
          cycles: [cycle('a', { state: 'NO_TRADE' })],
          transactions: [],
          ledgerTotals: {
            realizedGainMicros: '0',
            realizedLossMicros: '0',
            brokerExecutionFeesMicros: '0',
            otherChargedCostsMicros: '0',
            cashYieldMicros: '0',
          },
        }),
      ),
    )

    expect(receipt.evidence.reasonCodes).toContain('ZERO_COMPLETED_EXECUTIONS')
    expect(receipt.profitability).toBe('UNDETERMINED')
    expect(receipt.counts.completedExecutionCount).toBe(0)
  })

  test('missing starting capital is an evidence gap rather than malformed micros', () => {
    const receipt = success(makeForwardPerformanceReceipt(input({ startingCapitalMicros: undefined })))

    expect(receipt.evidence.reasonCodes).toContain('STARTING_CAPITAL_GAP')
    expect(receipt.evidence.reasonCodes).not.toContain('INVALID_MICROS')
    expect(receipt.profitability).toBe('UNDETERMINED')
  })

  test('invalid or overflowing integer-micro arithmetic fails closed', () => {
    const max = ((1n << 127n) - 1n).toString()
    const receipt = success(
      makeForwardPerformanceReceipt(
        input({
          transactions: [transaction('e', `-${max}`, max)],
          ledgerTotals: {
            realizedGainMicros: '0',
            realizedLossMicros: max,
            brokerExecutionFeesMicros: max,
            otherChargedCostsMicros: '0',
            cashYieldMicros: '0',
          },
        }),
      ),
    )

    expect(receipt.evidence.reasonCodes).toContain('INVALID_MICROS')
    expect(receipt.profitability).toBe('UNDETERMINED')
    expect(receipt.totals.netRealizedPnlAfterCostsMicros).toBeNull()
  })

  test('canonical ordering produces one deterministic content hash', () => {
    const secondCycle = cycle('f', {
      submissionOpenAt: '2026-07-21T13:00:00.000Z',
      terminalAt: '2026-07-21T21:00:00.000Z',
    })
    const first = success(makeForwardPerformanceReceipt(input({ cycles: [secondCycle, cycle('a')] })))
    const second = success(makeForwardPerformanceReceipt(input({ cycles: [cycle('a'), secondCycle] })))

    expect(first).toEqual(second)
    expect(first.receiptHash).toMatch(/^[0-9a-f]{64}$/)
    expect(JSON.stringify(first)).not.toContain('paper-account-1')
  })

  test('identity drift across completed cycles is insufficient', () => {
    const receipt = success(
      makeForwardPerformanceReceipt(
        input({
          cycles: [cycle('a'), cycle('f', { strategyProtocolHash: hash('f') })],
        }),
      ),
    )

    expect(receipt.evidence.reasonCodes).toContain('CYCLE_IDENTITY_DRIFT')
    expect(receipt.profitability).toBe('UNDETERMINED')
  })

  test('durable execution account drift is insufficient', () => {
    const baseline = input()
    const binding = baseline.durableExecutionBindings[0]
    assert(binding !== undefined)
    const receipt = success(
      makeForwardPerformanceReceipt(
        input({
          durableExecutionBindings: [{ ...binding, environment: 'live' }],
        }),
      ),
    )

    expect(receipt.evidence.reasonCodes).toContain('ACCOUNT_IDENTITY_GAP')
    expect(receipt.profitability).toBe('UNDETERMINED')
  })
})
