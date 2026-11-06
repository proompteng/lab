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
      'fa21a9d606eed0332637937d4d46035ba649d3fef968ab39480af796f13f419b',
    )
    expect(Result.getOrThrow(canonicalHashV1Result(momentum))).toBe(
      '4e1dd700b955b5cc7327aabc7e03244c06ac6d64bd4ecf95a57184ab32ec9df2',
    )
    expect(jev.lookbackMinutes).toEqual({ equity: 30, crypto: 120 })
    expect(jev.decisionDelaySeconds).toBe(2)
    expect(momentum.lookbackMinutes).toBe(jev.lookbackMinutes.equity)
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
