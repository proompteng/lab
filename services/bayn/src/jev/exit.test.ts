import { describe, expect, test } from 'bun:test'
import { Result, Schema } from 'effect'

import { IntradaySnapshotPurpose } from '../market-data'
import { persistIntradayRecordRows } from '../market-data/intraday/verification'
import { makeIntradayMomentumTestSnapshot } from '../strategy/intraday-momentum/test-support'
import { streamingFixtureFromRaw } from '../testing/streaming-market-fixture'
import { decideJevManagement } from './decision'
import { decideJevExit, jevExitCommitDeadline, JevExitReason, JevExitTargetSchema } from './exit'
import { nativeJevDecisionEvidence, nativeJevFixture } from './native.test-support'
import { JevPurpose } from './portfolio'
import { jevPricingQuery } from './runtime'

const fixture = nativeJevFixture(JevPurpose.Manage)
const evidence = {
  cycleId: fixture.draft.identity.cycleId,
  sessionDate: fixture.snapshot.manifest.sessionDate,
  protocol: fixture.protocol,
  portfolio: fixture.portfolio,
  observedAt: fixture.observation.payload.observedAt,
}

describe('native Jev exit targets', () => {
  test('pricing waits at the exact minute boundary instead of invalidating the position', () => {
    const result = jevPricingQuery(
      fixture.draft,
      fixture.protocol,
      fixture.snapshot.manifest.calendar,
      '2026-09-04T14:30:00.000Z',
      ['AAPL'],
      IntradaySnapshotPurpose.Liquidation,
    )
    expect(Result.isFailure(result)).toBe(true)
    if (Result.isFailure(result))
      expect(result.failure).toMatchObject({ _tag: 'JevAwaitingEvidence', availableAt: '2026-09-04T14:30:00.001Z' })
  })
  test('reproduces an exit for exactly the held position from the complete model response', () => {
    const decision = Result.getOrThrow(decideJevManagement(nativeJevDecisionEvidence(fixture, 'exit')))
    const material = {
      ...evidence,
      observedAt: decision.evidence.decidedAt,
      trigger: { reason: JevExitReason.Model, decision },
    }
    const target = Result.getOrThrow(decideJevExit(material))
    expect(target.targetWeights).toEqual({ AAPL: 0 })
    expect(jevExitCommitDeadline(target)).toBe(decision.evidence.batchPlan.expiresAt)
    expect(
      Result.getOrThrow(Schema.decodeUnknownResult(JevExitTargetSchema)(JSON.parse(JSON.stringify(target)))),
    ).toEqual(target)
    for (const altered of [
      { ...target, targetWeights: { AAPL: 0.1 } },
      { ...target, reason: JevExitReason.MaximumHold },
      { ...target, cycleId: '0'.repeat(64) },
      { ...target, entryDecisionHash: '0'.repeat(64) },
    ])
      expect(Result.isFailure(Schema.decodeUnknownResult(JevExitTargetSchema)(altered))).toBe(true)
    const hold = Result.getOrThrow(decideJevManagement(nativeJevDecisionEvidence(fixture, 'hold')))
    expect(
      Result.isFailure(decideJevExit({ ...material, trigger: { reason: JevExitReason.Model, decision: hold } })),
    ).toBe(true)
  })

  test('the holding limit starts at the first real partial fill and does not require inference', () => {
    if (fixture.portfolio.purpose !== JevPurpose.Manage) throw new Error('Expected held position')
    const firstAt = Date.parse(evidence.observedAt) - fixture.protocol.maximumHoldingMinutes * 60_000
    const material = {
      ...evidence,
      portfolio: {
        ...fixture.portfolio,
        entryFills: fixture.portfolio.entryFills.map((fill, index) => ({
          ...fill,
          occurredAt: new Date(firstAt + index * 1000).toISOString(),
        })),
      },
      trigger: { reason: JevExitReason.MaximumHold },
    }
    expect(Result.getOrThrow(decideJevExit(material)).reason).toBe(JevExitReason.MaximumHold)
    expect(
      Result.isFailure(
        decideJevExit({
          ...material,
          portfolio: {
            ...material.portfolio,
            entryFills: material.portfolio.entryFills.map((fill) => ({
              ...fill,
              occurredAt: new Date(Date.parse(fill.occurredAt) + 1).toISOString(),
            })),
          },
        }),
      ),
    ).toBe(true)
    expect(
      Result.isFailure(
        decideJevExit({ ...material, observedAt: new Date(Date.parse(evidence.observedAt) + 10_001).toISOString() }),
      ),
    ).toBe(true)
  })

  test('the protective stop requires a fresh verified adverse bid, not a model score or substituted price', () => {
    const query = Result.getOrThrow(
      jevPricingQuery(
        fixture.draft,
        fixture.protocol,
        fixture.snapshot.manifest.calendar,
        evidence.observedAt,
        ['AAPL'],
        IntradaySnapshotPurpose.Liquidation,
      ),
    )
    const pricing = (change: number) =>
      streamingFixtureFromRaw(
        makeIntradayMomentumTestSnapshot(fixture.protocol, { ...query, archiveWatermarks: [] }, { AAPL: change }),
        query,
      ).snapshot
    const snapshot = pricing(-0.02)
    const trigger = {
      reason: JevExitReason.ProtectiveStop,
      manifest: snapshot.manifest,
      rows: Result.getOrThrow(persistIntradayRecordRows(snapshot)),
    }
    expect(Result.getOrThrow(decideJevExit({ ...evidence, trigger })).reason).toBe(JevExitReason.ProtectiveStop)
    const aboveStop = pricing(0.02)
    expect(
      Result.isFailure(
        decideJevExit({
          ...evidence,
          trigger: {
            ...trigger,
            manifest: aboveStop.manifest,
            rows: Result.getOrThrow(persistIntradayRecordRows(aboveStop)),
          },
        }),
      ),
    ).toBe(true)
    expect(
      Result.isFailure(
        decideJevExit({ ...evidence, trigger: { ...trigger, manifest: { ...snapshot.manifest, feed: 'sip' } } }),
      ),
    ).toBe(true)
  })
})
