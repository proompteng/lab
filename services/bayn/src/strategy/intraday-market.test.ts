import { describe, expect, test } from 'bun:test'
import { Result } from 'effect'

import { canonicalHashV1OrThrow } from '../hash'
import { decodeJevProtocol, defaultJevProtocolDocument } from '../jev/protocol'
import { decodeDefaultIntradayMomentumProtocol } from './intraday-momentum/protocol'

describe('shared intraday market contract', () => {
  test('preserves the active and retained protocol identities', () => {
    const jev = Result.getOrThrow(decodeJevProtocol(defaultJevProtocolDocument))
    const momentum = Result.getOrThrow(decodeDefaultIntradayMomentumProtocol())

    expect(canonicalHashV1OrThrow(jev)).toBe('86a3015dca27e514c7d3f53ecb27d3648e7fce1ea0c2e25325df6bbff83524bd')
    expect(canonicalHashV1OrThrow(momentum)).toBe('cd004b8b43e50dde70ba70fb43deff19c5c65d60f4455e84a2e8df9991c0335f')
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
