import assert from 'node:assert/strict'

import { describe, expect, test } from 'bun:test'
import { Result } from 'effect'

import { DataSource } from '../../contracts'
import type { SignalSessionRow } from '../../market-data/rows'
import {
  bindOpeningDriveQualificationVersions,
  prepareOpeningDriveQualificationCalendar,
  versionOpeningDriveQualificationSession,
} from './qualification-runner'
import { decodeDefaultOpeningDriveProtocol } from './protocol'

const success = <A, E>(result: Result.Result<A, E>): A => {
  assert(Result.isSuccess(result), 'fixture must succeed')
  return result.success
}

const protocol = success(decodeDefaultOpeningDriveProtocol())

const row = (sessionDate: SignalSessionRow['session_date'], open = '09:30', close = '16:00'): SignalSessionRow => ({
  snapshot_id: 'a'.repeat(64),
  calendar_version: 'alpaca-us-equity-calendar-v1',
  session_date: sessionDate,
  open_time: open,
  close_time: close,
  timezone: 'America/New_York',
  provider: DataSource.Alpaca,
})

const watermarks = (offset: string) => [
  { sourceTopic: 'torghut.bars.1m.v1', sourcePartition: 0, inclusiveLastOffset: offset },
  { sourceTopic: 'torghut.quotes.v1', sourcePartition: 0, inclusiveLastOffset: offset },
  { sourceTopic: 'torghut.trades.v1', sourcePartition: 0, inclusiveLastOffset: offset },
]

describe('opening-drive qualification runner', () => {
  test('freezes Signal calendar sessions into DST-correct entry and flatten snapshot plans', () => {
    const prepared = success(
      prepareOpeningDriveQualificationCalendar({
        sessions: [row('2026-01-05'), row('2026-07-06')],
        finalizedAt: '2026-07-06 22:00:00.000',
        protocol,
      }),
    )

    expect(prepared.calendar).toMatchObject({
      source: 'signal.exchange_sessions_v1',
      firstSession: '2026-01-05',
      lastSession: '2026-07-06',
      finalizedAt: '2026-07-06T22:00:00.000Z',
    })
    expect(prepared.calendar.sessions[0]).toMatchObject({
      sessionDate: '2026-01-05',
      openAt: '2026-01-05T14:30:00.000Z',
      closeAt: '2026-01-05T21:00:00.000Z',
    })
    expect(prepared.calendar.sessions[1]).toMatchObject({
      sessionDate: '2026-07-06',
      openAt: '2026-07-06T13:30:00.000Z',
      closeAt: '2026-07-06T20:00:00.000Z',
    })
    expect(prepared.sessions[0]?.openingQuery).toMatchObject({
      rangeStartAt: '2026-01-05T14:30:00.000Z',
      rangeEndAt: '2026-01-05T14:35:00.000Z',
      observedAt: '2026-01-05T14:35:01.000Z',
      minimumWatermarkLagMs: 1_000,
    })
    expect(prepared.sessions[0]?.exitQuery).toMatchObject({
      rangeStartAt: '2026-01-05T20:29:00.000Z',
      rangeEndAt: '2026-01-05T20:30:00.000Z',
      observedAt: '2026-01-05T20:30:01.000Z',
      minimumWatermarkLagMs: 0,
    })
  })

  test('binds the exact archive watermarks and prior trial lineage before replay rows can be loaded', () => {
    const prepared = success(
      prepareOpeningDriveQualificationCalendar({
        sessions: [row('2026-07-06')],
        finalizedAt: '2026-07-06 22:00:00.000',
        protocol,
      }),
    )
    const plan = prepared.sessions[0]
    assert(plan !== undefined)
    const versioned = success(
      versionOpeningDriveQualificationSession(
        plan,
        { ...plan.openingQuery, archiveWatermarks: watermarks('100') },
        { ...plan.exitQuery, archiveWatermarks: watermarks('200') },
      ),
    )
    const prior = ['0'.repeat(64), 'f'.repeat(64)]
    const lock = success(
      bindOpeningDriveQualificationVersions([versioned], {
        sourceRevision: 'a'.repeat(40),
        protocol,
        calendar: prepared.calendar,
        priorTrialReceiptHashes: prior.toReversed(),
      }),
    )
    const changed = success(
      versionOpeningDriveQualificationSession(
        plan,
        { ...plan.openingQuery, archiveWatermarks: watermarks('101') },
        { ...plan.exitQuery, archiveWatermarks: watermarks('200') },
      ),
    )
    const changedLock = success(
      bindOpeningDriveQualificationVersions([changed], {
        sourceRevision: 'a'.repeat(40),
        protocol,
        calendar: prepared.calendar,
        priorTrialReceiptHashes: prior,
      }),
    )

    const laterTrialLineage = success(
      bindOpeningDriveQualificationVersions([versioned], {
        sourceRevision: 'a'.repeat(40),
        protocol,
        calendar: prepared.calendar,
        priorTrialReceiptHashes: ['1'.repeat(64)],
      }),
    )

    expect(lock.binding.priorTrialReceiptHashes).toEqual(prior)
    expect(lock.binding.replayVersionGraphHash).not.toBe(changedLock.binding.replayVersionGraphHash)
    expect(lock.lockId).not.toBe(changedLock.lockId)
    expect(lock.candidateKey).toBe(laterTrialLineage.candidateKey)
    expect(lock.lockId).not.toBe(laterTrialLineage.lockId)
  })

  test('fails closed on omitted order or mixed Signal calendar versions', () => {
    const outOfOrder = prepareOpeningDriveQualificationCalendar({
      sessions: [row('2026-07-07'), row('2026-07-06')],
      finalizedAt: '2026-07-07 22:00:00.000',
      protocol,
    })
    expect(Result.isFailure(outOfOrder)).toBe(true)

    const mixed = prepareOpeningDriveQualificationCalendar({
      sessions: [row('2026-07-06'), { ...row('2026-07-07'), calendar_version: 'other-calendar' }],
      finalizedAt: '2026-07-07 22:00:00.000',
      protocol,
    })
    expect(Result.isFailure(mixed)).toBe(true)
  })
})
