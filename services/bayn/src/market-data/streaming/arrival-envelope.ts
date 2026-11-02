export enum ArrivalEnvelopeInvalidReason {
  InvalidClock = 'INVALID_CLOCK',
  ClockRegression = 'CLOCK_REGRESSION',
  CounterOverflow = 'COUNTER_OVERFLOW',
}

export const makeKafkaArrivalEnvelope = () => {
  const windows = [1, 10, 100, 1000].map((windowMs) => ({
    windowMs,
    bucket: -1,
    records: 0,
    knownRawBytes: 0,
    previousRecords: 0,
    previousKnownRawBytes: 0,
    maximumAlignedRecords: 0,
    maximumAdjacentRecords: 0,
    maximumAlignedKnownRawBytes: 0,
    maximumAdjacentKnownRawBytes: 0,
  }))
  let firstObservedAtMs: number | null = null
  let lastObservedAtMs: number | null = null
  let observedRecordCount = 0
  let knownRawBytes = 0
  let unknownRawByteLengthRecords = 0
  let invalidReason: ArrivalEnvelopeInvalidReason | undefined

  const observe = (atMs: number, rawByteLength: number | null | undefined): void => {
    if (invalidReason !== undefined) return
    if (!Number.isSafeInteger(atMs) || atMs < 0) {
      invalidReason = ArrivalEnvelopeInvalidReason.InvalidClock
      return
    }
    if (lastObservedAtMs !== null && atMs < lastObservedAtMs) {
      invalidReason = ArrivalEnvelopeInvalidReason.ClockRegression
      return
    }
    const bytes =
      typeof rawByteLength === 'number' && Number.isSafeInteger(rawByteLength) && rawByteLength >= 0
        ? rawByteLength
        : undefined
    if (!Number.isSafeInteger(observedRecordCount + 1) || !Number.isSafeInteger(knownRawBytes + (bytes ?? 0))) {
      invalidReason = ArrivalEnvelopeInvalidReason.CounterOverflow
      return
    }
    firstObservedAtMs ??= atMs
    lastObservedAtMs = atMs
    observedRecordCount++
    knownRawBytes += bytes ?? 0
    if (bytes === undefined) unknownRawByteLengthRecords++
    for (const window of windows) {
      const bucket = Math.floor(atMs / window.windowMs)
      if (bucket !== window.bucket) {
        window.previousRecords = bucket === window.bucket + 1 ? window.records : 0
        window.previousKnownRawBytes = bucket === window.bucket + 1 ? window.knownRawBytes : 0
        window.records = 0
        window.knownRawBytes = 0
        window.bucket = bucket
      }
      window.records++
      window.knownRawBytes += bytes ?? 0
      window.maximumAlignedRecords = Math.max(window.maximumAlignedRecords, window.records)
      window.maximumAdjacentRecords = Math.max(window.maximumAdjacentRecords, window.previousRecords + window.records)
      window.maximumAlignedKnownRawBytes = Math.max(window.maximumAlignedKnownRawBytes, window.knownRawBytes)
      window.maximumAdjacentKnownRawBytes = Math.max(
        window.maximumAdjacentKnownRawBytes,
        window.previousKnownRawBytes + window.knownRawBytes,
      )
    }
  }

  const measurement = () => ({
    schemaVersion: 'bayn.kafka-arrival-envelope.v1',
    valid: invalidReason === undefined,
    invalidReason: invalidReason ?? null,
    firstObservedAtMs,
    lastObservedAtMs,
    observedRecordCount,
    knownRawBytes,
    unknownRawByteLengthRecords,
    windows: windows.map((window) => ({
      windowMs: window.windowMs,
      maximumAlignedWindowRecords: window.maximumAlignedRecords,
      maximumWindowRecordsUpperBound: invalidReason === undefined ? window.maximumAdjacentRecords : null,
      maximumAlignedWindowKnownRawBytes: window.maximumAlignedKnownRawBytes,
      maximumWindowRawBytesUpperBound:
        invalidReason === undefined && unknownRawByteLengthRecords === 0 ? window.maximumAdjacentKnownRawBytes : null,
    })),
  })

  return { observe, measurement }
}
