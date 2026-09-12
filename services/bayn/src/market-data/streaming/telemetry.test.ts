import { expect, test } from 'bun:test'
import { partitionLagMeasurements, projectionCoverageMeasurements, safeKafkaFailureCodes } from './telemetry'
import { AuthenticationError, MultipleErrors, ProtocolError, TimeoutError } from '@platformatic/kafka'
import { emptyStreamingProjection } from './projection'
import { canonicalJsonV1Result } from '../../hash'
import { Result } from 'effect'

test('failure classification retains SDK and broker codes without leaking error messages', () => {
  const secretMessage = 'credential-bearing broker detail'
  expect(safeKafkaFailureCodes(new AuthenticationError(secretMessage))).toEqual(['PLT_KFK_AUTHENTICATION'])
  const codes = safeKafkaFailureCodes(
    new MultipleErrors(secretMessage, [
      new ProtocolError('TOPIC_AUTHORIZATION_FAILED', secretMessage),
      new TimeoutError(secretMessage),
    ]),
  )
  expect(codes).toContain('TOPIC_AUTHORIZATION_FAILED')
  expect(codes).toContain('PLT_KFK_TIMEOUT')
  expect(JSON.stringify(codes)).not.toContain(secretMessage)
  expect(safeKafkaFailureCodes(new Error(secretMessage))).toEqual(['UNKNOWN'])
})

test('offset lag retains integer precision and distinguishes unknown ends from zero lag', () => {
  const positions = [
    { topic: 'bars', partition: 0, offset: '9007199254740993' },
    { topic: 'quotes', partition: 0, offset: '9' },
    { topic: 'trades', partition: 0, offset: '4' },
  ]
  expect(
    partitionLagMeasurements(positions, [
      { topic: 'bars', partition: 0, offset: '9007199254741000' },
      { topic: 'quotes', partition: 0, offset: '8' },
    ]).map(({ lagOffsets }) => lagOffsets),
  ).toEqual(['7', '0', null])
  expect(partitionLagMeasurements(positions, undefined).every(({ lagOffsets }) => lagOffsets === null)).toBe(true)
})

test('an absent symbol reports missing coverage without fabricating zero event age', () => {
  const observedAtMs = Date.parse('2026-09-11T14:00:02Z')
  const measurements = projectionCoverageMeasurements(emptyStreamingProjection('epoch'), ['AMD'], observedAtMs)
  expect(measurements.windowEndMs).toBe(Date.parse('2026-09-11T14:00:00Z'))
  expect(measurements.symbols).toEqual([
    {
      symbol: 'AMD',
      expectedBars: 30,
      observedBars: 0,
      windowFeatures: 0,
      matchedFeatures: 0,
      unmatchedFeatures: 0,
      quoteAgeMs: null,
      tradeAgeMs: null,
    },
  ])
  expect(Result.isSuccess(canonicalJsonV1Result(measurements))).toBe(true)
})
