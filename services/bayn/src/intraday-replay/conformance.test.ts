import { readFileSync } from 'node:fs'
import { expect, test } from 'bun:test'
import { Result, Schema } from 'effect'
import { canonicalHashV1Result } from '../hash'
import { ExecutionMarketDataBindingSchema } from '../shadow-decision-contract'
import { decodeIntradayMomentumProtocol } from '../strategy/intraday-momentum/protocol'

test('retained archive evidence stays immutable and cannot enter the canonical trading runtime', () => {
  const raw: unknown = JSON.parse(
    readFileSync(new URL('./fixtures/2026-09-10-iwm-decision.json', import.meta.url), 'utf8'),
  )
  expect(Result.getOrThrow(canonicalHashV1Result(raw))).toBe(
    '8bdc4ef305ac3ff214520d0aea4bca805045c0156dc5639d6520298105b14d37',
  )
  const fixture = Schema.decodeUnknownSync(
    Schema.Struct({
      protocol: Schema.Unknown,
      decisionBinding: Schema.Unknown,
      expectedDecision: Schema.Unknown,
      expectedDecisionHash: Schema.String,
      readerCompletedAt: Schema.String,
      sourceCutoffAt: Schema.String,
      arrivalAt: Schema.Null,
    }),
  )(raw)
  expect(Result.getOrThrow(canonicalHashV1Result(fixture.expectedDecision))).toBe(fixture.expectedDecisionHash)
  expect(Result.isFailure(decodeIntradayMomentumProtocol(fixture.protocol))).toBeTrue()
  expect(
    Result.isFailure(Schema.decodeUnknownResult(ExecutionMarketDataBindingSchema)(fixture.decisionBinding)),
  ).toBeTrue()
  expect(fixture.readerCompletedAt > fixture.sourceCutoffAt).toBeTrue()
  expect(fixture.arrivalAt).toBeNull()
})
