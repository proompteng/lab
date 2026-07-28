import { Result, Schema } from 'effect'

import type { EvaluationEvent, InputManifest } from '../types'

export interface LedgerInput {
  readonly runId: string
  readonly initialCapitalMicros: string
  readonly inputManifest: InputManifest
  readonly events: readonly EvaluationEvent[]
}

export type LedgerPlanInputField =
  | 'cashYield.amountMicros'
  | 'cashYield.id'
  | 'event.kind'
  | 'events'
  | 'fee.id'
  | 'fee.totalMicros'
  | 'fill.costBasisMicros'
  | 'fill.id'
  | 'fill.notionalMicros'
  | 'fill.side'
  | 'fill.symbol'
  | 'initialCapitalMicros'
  | 'inputManifest.symbol'
  | 'inputManifest.symbols'
  | 'runId'

export interface LedgerInputDecodeFailure {
  readonly field: LedgerPlanInputField
  readonly cause: unknown
  readonly eventIndex?: number
  readonly eventKind?: EvaluationEvent['kind']
}

interface InputAccessContext {
  field: LedgerPlanInputField
  eventIndex?: number
  eventKind?: EvaluationEvent['kind']
}

const LedgerInputBoundarySchema = Schema.Struct({
  runId: Schema.Unknown,
  initialCapitalMicros: Schema.Unknown,
  inputManifest: Schema.Struct({
    symbols: Schema.Array(Schema.Struct({ symbol: Schema.Unknown })),
  }),
  events: Schema.Array(Schema.Record(Schema.String, Schema.Unknown)),
})

const decodeUnknownLedgerMaterial = Schema.decodeUnknownResult(LedgerInputBoundarySchema)

const eventInputField = (kind: unknown, property: PropertyKey): LedgerPlanInputField => {
  if (property === 'kind') return 'event.kind'
  if (kind === 'fill') {
    if (property === 'id') return 'fill.id'
    if (property === 'symbol') return 'fill.symbol'
    if (property === 'side') return 'fill.side'
    if (property === 'notionalMicros') return 'fill.notionalMicros'
    if (property === 'costBasisMicros') return 'fill.costBasisMicros'
  }
  if (kind === 'fee') {
    if (property === 'id') return 'fee.id'
    if (property === 'totalMicros') return 'fee.totalMicros'
  }
  if (kind === 'cash-yield') {
    if (property === 'id') return 'cashYield.id'
    if (property === 'amountMicros') return 'cashYield.amountMicros'
  }
  return 'event.kind'
}

const inputAccessFailure = (access: InputAccessContext, cause: unknown): LedgerInputDecodeFailure => ({
  field: access.field,
  ...(access.eventIndex === undefined ? {} : { eventIndex: access.eventIndex }),
  ...(access.eventKind === undefined ? {} : { eventKind: access.eventKind }),
  cause,
})

export const decodeLedgerInput = (input: unknown): Result.Result<LedgerInput, LedgerInputDecodeFailure> => {
  let access: InputAccessContext = { field: 'runId' }
  const snapshot = Result.mapError(
    Result.try(() => {
      const source = input as LedgerInput
      access = { field: 'runId' }
      const runId = source.runId as unknown
      access = { field: 'initialCapitalMicros' }
      const initialCapitalMicros = source.initialCapitalMicros as unknown
      access = { field: 'inputManifest.symbols' }
      const rawSymbols = [...source.inputManifest.symbols]
      const symbols = rawSymbols.map((coverage, index) => {
        access = { field: 'inputManifest.symbol', eventIndex: index }
        return { symbol: coverage.symbol as unknown }
      })
      access = { field: 'events' }
      const rawEvents = [...source.events]
      const events = rawEvents.map((event, eventIndex) => {
        access = { field: 'event.kind', eventIndex }
        const kind = event.kind
        const entries = Object.keys(event).map((property) => {
          access = { field: eventInputField(kind, property), eventIndex, eventKind: kind }
          return [property, (event as unknown as Record<string, unknown>)[property]] as const
        })
        return Object.fromEntries(entries)
      })
      return { runId, initialCapitalMicros, inputManifest: { symbols }, events }
    }),
    (cause) => inputAccessFailure(access, cause),
  )
  if (Result.isFailure(snapshot)) return Result.fail(snapshot.failure)

  return Result.map(
    Result.mapError(decodeUnknownLedgerMaterial(snapshot.success), (cause) =>
      inputAccessFailure({ field: 'runId' }, cause),
    ),
    (decoded) => decoded as LedgerInput,
  )
}
