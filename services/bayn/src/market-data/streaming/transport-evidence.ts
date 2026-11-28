import { Schema } from 'effect'

export enum CaptureDisposition {
  Accepted = 'ACCEPTED',
  Rejected = 'REJECTED',
  Ignored = 'IGNORED',
}

export enum CaptureTimestampKind {
  Value = 'VALUE',
  Missing = 'MISSING',
  NotANumber = 'NAN',
  PositiveInfinity = 'POSITIVE_INFINITY',
  NegativeInfinity = 'NEGATIVE_INFINITY',
  NegativeZero = 'NEGATIVE_ZERO',
}
const CaptureTimestampSchema = Schema.Union([
  Schema.Struct({
    kind: Schema.Literal(CaptureTimestampKind.Value),
    value: Schema.Finite.check(
      Schema.makeFilter((value: number) => !Object.is(value, -0), {
        expected: 'a finite timestamp with negative zero separately tagged',
      }),
    ),
  }),
  Schema.Struct({
    kind: Schema.Literals([
      CaptureTimestampKind.Missing,
      CaptureTimestampKind.NotANumber,
      CaptureTimestampKind.PositiveInfinity,
      CaptureTimestampKind.NegativeInfinity,
      CaptureTimestampKind.NegativeZero,
    ]),
  }),
])
export const OriginalKafkaTransportSchema = Schema.Struct({
  schemaVersion: Schema.Literal('bayn.kafka-original-transport.v1'),
  timestampMs: CaptureTimestampSchema,
})
type CapturedTimestamp = typeof CaptureTimestampSchema.Type
const captureTimestamp = (value: number | undefined): CapturedTimestamp => {
  if (value === undefined) return { kind: CaptureTimestampKind.Missing }
  if (Number.isNaN(value)) return { kind: CaptureTimestampKind.NotANumber }
  if (value === Infinity) return { kind: CaptureTimestampKind.PositiveInfinity }
  if (value === -Infinity) return { kind: CaptureTimestampKind.NegativeInfinity }
  if (Object.is(value, -0)) return { kind: CaptureTimestampKind.NegativeZero }
  return { kind: CaptureTimestampKind.Value, value }
}
export const captureKafkaTransport = (timestampMs: number | undefined): typeof OriginalKafkaTransportSchema.Type => ({
  schemaVersion: 'bayn.kafka-original-transport.v1',
  timestampMs: captureTimestamp(timestampMs),
})
export const restoreKafkaTransportTimestamp = (
  transport: typeof OriginalKafkaTransportSchema.Type,
): number | undefined => {
  switch (transport.timestampMs.kind) {
    case CaptureTimestampKind.Value:
      return transport.timestampMs.value
    case CaptureTimestampKind.Missing:
      return undefined
    case CaptureTimestampKind.NotANumber:
      return NaN
    case CaptureTimestampKind.PositiveInfinity:
      return Infinity
    case CaptureTimestampKind.NegativeInfinity:
      return -Infinity
    case CaptureTimestampKind.NegativeZero:
      return -0
  }
}
