import { decodeIntradayMomentumProtocol, defaultIntradayMomentumProtocolDocument } from './intraday-momentum/protocol'
import { describe, expect, test } from 'bun:test'
import { Result } from 'effect'

import { canonicalHashV1Result } from '../hash'
import { decodeJevProtocol, defaultJevProtocolDocument } from '../jev/protocol'

describe('shared intraday market contract', () => {
  test('binds active and research protocols to observed-history features', () => {
    const jev = Result.getOrThrow(decodeJevProtocol(defaultJevProtocolDocument))
    const momentum = Result.getOrThrow(decodeIntradayMomentumProtocol(defaultIntradayMomentumProtocolDocument))

    expect(Result.getOrThrow(canonicalHashV1Result(jev))).toBe(
      'd4d9cef267f4d4fde8246ec0b345ce3ce52862588c207fbc247e1622b1f87801',
    )
    expect(Result.getOrThrow(canonicalHashV1Result(momentum))).toBe(
      '0dccbe2abe3a380a987bcb2bbf6af299ff317d94df0198a35de3f89cbd28a775',
    )
    expect(jev.lookbackMinutes).toBe(30)
    expect(jev.decisionDelaySeconds).toBe(2)
    expect(momentum.lookbackMinutes).toBe(jev.lookbackMinutes)
    expect(momentum.decisionDelaySeconds).toBe(jev.decisionDelaySeconds)
  })

  test.each([
    { lookbackMinutes: 29 },
    { lookbackMinutes: 31 },
    { decisionDelaySeconds: 1 },
    { decisionDelaySeconds: 3 },
  ])('rejects a Jev window that differs from its pinned contract: %j', (window) => {
    expect(Result.isFailure(decodeJevProtocol({ ...defaultJevProtocolDocument, ...window }))).toBe(true)
  })
})
