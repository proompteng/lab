import { expect, test } from 'bun:test'
import fc from 'fast-check'

import { ArrivalEnvelopeInvalidReason, makeKafkaArrivalEnvelope } from './arrival-envelope'

test('an empty epoch has no observed workload and snapshots do not change after later arrivals', () => {
  const arrivals = makeKafkaArrivalEnvelope()
  const before = arrivals.measurement()
  expect(before).toMatchObject({
    valid: true,
    invalidReason: null,
    firstObservedAtMs: null,
    lastObservedAtMs: null,
    observedRecordCount: 0,
    knownRawBytes: 0,
    unknownRawByteLengthRecords: 0,
  })
  expect(before.windows).toHaveLength(4)
  arrivals.observe(1234, 7)
  expect(before.observedRecordCount).toBe(0)
  expect(before.windows.every((window) => window.maximumWindowRecordsUpperBound === 0)).toBe(true)
  expect(arrivals.measurement()).toMatchObject({
    firstObservedAtMs: 1234,
    lastObservedAtMs: 1234,
    observedRecordCount: 1,
    knownRawBytes: 7,
  })
  expect(makeKafkaArrivalEnvelope().measurement()).toEqual(before)
})

test('bursts spanning an aligned boundary retain both bins and variable raw payload sizes', () => {
  const arrivals = makeKafkaArrivalEnvelope()
  for (let index = 0; index < 3; index++) arrivals.observe(999, 5)
  for (let index = 0; index < 4; index++) arrivals.observe(1000, 8)
  expect(arrivals.measurement()).toMatchObject({
    valid: true,
    observedRecordCount: 7,
    knownRawBytes: 47,
    unknownRawByteLengthRecords: 0,
  })
  for (const window of arrivals.measurement().windows)
    expect(window).toMatchObject({
      maximumAlignedWindowRecords: 4,
      maximumWindowRecordsUpperBound: 7,
      maximumAlignedWindowKnownRawBytes: 32,
      maximumWindowRawBytesUpperBound: 47,
    })
})

test('an idle gap cannot combine nonadjacent bins into a burst', () => {
  const arrivals = makeKafkaArrivalEnvelope()
  arrivals.observe(0, 5)
  arrivals.observe(2000, 7)
  expect(arrivals.measurement().windows).toEqual(
    [1, 10, 100, 1000].map((windowMs) => ({
      windowMs,
      maximumAlignedWindowRecords: 1,
      maximumWindowRecordsUpperBound: 1,
      maximumAlignedWindowKnownRawBytes: 7,
      maximumWindowRawBytesUpperBound: 7,
    })),
  )
})

test('unknown lengths preserve count bounds and known byte lower bounds without inventing byte upper bounds', () => {
  const arrivals = makeKafkaArrivalEnvelope()
  arrivals.observe(0, 2)
  arrivals.observe(0, 0)
  for (const bytes of [undefined, null, -1, NaN, Infinity, 1.5, Number.MAX_SAFE_INTEGER + 1]) arrivals.observe(0, bytes)
  expect(arrivals.measurement()).toMatchObject({
    valid: true,
    observedRecordCount: 9,
    knownRawBytes: 2,
    unknownRawByteLengthRecords: 7,
  })
  for (const window of arrivals.measurement().windows)
    expect(window).toMatchObject({
      maximumAlignedWindowRecords: 9,
      maximumWindowRecordsUpperBound: 9,
      maximumAlignedWindowKnownRawBytes: 2,
      maximumWindowRawBytesUpperBound: null,
    })
})

test.each([-1, NaN, Infinity, 1.5, Number.MAX_SAFE_INTEGER + 1])(
  'an invalid record clock permanently invalidates the epoch envelope (%s)',
  (atMs) => {
    const arrivals = makeKafkaArrivalEnvelope()
    arrivals.observe(10, 2)
    arrivals.observe(atMs, 3)
    arrivals.observe(20, 4)
    expect(arrivals.measurement()).toMatchObject({
      valid: false,
      invalidReason: ArrivalEnvelopeInvalidReason.InvalidClock,
      lastObservedAtMs: 10,
      observedRecordCount: 1,
      knownRawBytes: 2,
    })
    for (const window of arrivals.measurement().windows) {
      expect(window.maximumWindowRecordsUpperBound).toBeNull()
      expect(window.maximumWindowRawBytesUpperBound).toBeNull()
    }
  },
)

test('clock regression invalidates only the measurement and cannot recover within the same epoch', () => {
  const arrivals = makeKafkaArrivalEnvelope()
  arrivals.observe(1000, 2)
  arrivals.observe(999, 3)
  arrivals.observe(2000, 4)
  expect(arrivals.measurement()).toMatchObject({
    valid: false,
    invalidReason: ArrivalEnvelopeInvalidReason.ClockRegression,
    lastObservedAtMs: 1000,
    observedRecordCount: 1,
    knownRawBytes: 2,
  })
})

test('counter overflow cannot serialize a misleading complete envelope', () => {
  const arrivals = makeKafkaArrivalEnvelope()
  arrivals.observe(0, Number.MAX_SAFE_INTEGER)
  arrivals.observe(1, 1)
  arrivals.observe(2, 0)
  const measurement = arrivals.measurement()
  expect(measurement).toMatchObject({
    valid: false,
    invalidReason: ArrivalEnvelopeInvalidReason.CounterOverflow,
    observedRecordCount: 1,
    knownRawBytes: Number.MAX_SAFE_INTEGER,
  })
  expect(measurement.windows.every((window) => window.maximumWindowRawBytesUpperBound === null)).toBe(true)
  expect(JSON.parse(JSON.stringify(measurement))).toEqual(measurement)
})

test('property: aligned lower bounds and adjacent-bin upper bounds contain exact rolling maxima', () => {
  fc.assert(
    fc.property(
      fc.constantFrom(0, Date.parse('2026-10-12T13:30:00.000Z')),
      fc.array(fc.record({ at: fc.integer({ min: 0, max: 10_000 }), bytes: fc.integer({ min: 0, max: 10_000 }) }), {
        maxLength: 128,
      }),
      (base, supplied) => {
        const records = supplied.toSorted((left, right) => left.at - right.at)
        const arrivals = makeKafkaArrivalEnvelope()
        for (const record of records) arrivals.observe(base + record.at, record.bytes)
        const measurement = arrivals.measurement()
        expect(measurement.valid).toBe(true)
        expect(measurement.observedRecordCount).toBe(records.length)
        for (const window of measurement.windows) {
          let maximumRecords = 0
          let maximumBytes = 0
          for (const end of records) {
            const contained = records.filter((record) => record.at > end.at - window.windowMs && record.at <= end.at)
            maximumRecords = Math.max(maximumRecords, contained.length)
            maximumBytes = Math.max(
              maximumBytes,
              contained.reduce((sum, record) => sum + record.bytes, 0),
            )
          }
          expect(window.maximumAlignedWindowRecords).toBeLessThanOrEqual(maximumRecords)
          expect(window.maximumWindowRecordsUpperBound).toBeGreaterThanOrEqual(maximumRecords)
          expect(window.maximumAlignedWindowKnownRawBytes).toBeLessThanOrEqual(maximumBytes)
          expect(window.maximumWindowRawBytesUpperBound).toBeGreaterThanOrEqual(maximumBytes)
        }
      },
    ),
    { numRuns: 200, seed: 20261010 },
  )
})
