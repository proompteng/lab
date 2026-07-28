import { Result } from 'effect'

import type { CashYieldEvent, EvaluationEvent, FeeEvent, FillEvent } from '../types'
import {
  failLedgerPlan,
  type LedgerPlanAmountField,
  type LedgerPlanFailureDetail,
  type LedgerPlanInputField,
} from './model'

interface DecodedFillEvent {
  readonly event: FillEvent
  readonly id: string
  readonly symbol: string
  readonly side: FillEvent['side']
  readonly notionalMicros: bigint
  readonly costBasisMicros: bigint
}

interface DecodedFeeEvent {
  readonly event: FeeEvent
  readonly id: string
  readonly totalMicros: bigint
}

interface DecodedCashYieldEvent {
  readonly event: CashYieldEvent
  readonly id: string
  readonly amountMicros: bigint
}

export interface DecodedLedgerInput {
  readonly runId: string
  readonly initialCapitalMicros: bigint
  readonly inventorySymbols: readonly string[]
  readonly eventCount: number
  readonly fills: readonly DecodedFillEvent[]
  readonly fees: readonly DecodedFeeEvent[]
  readonly cashYields: readonly DecodedCashYieldEvent[]
}

interface InputAccessContext {
  field: LedgerPlanInputField
  eventIndex?: number
  eventKind?: EvaluationEvent['kind']
}

const actualType = (value: unknown): string => (value === null ? 'null' : typeof value)

const inputAccessFailure = (access: InputAccessContext, cause: unknown): LedgerPlanFailureDetail => ({
  kind: 'input-access-failed',
  field: access.field,
  ...(access.eventIndex === undefined ? {} : { eventIndex: access.eventIndex }),
  ...(access.eventKind === undefined ? {} : { eventKind: access.eventKind }),
  cause,
})

const invalidInputValue = (
  field: LedgerPlanInputField,
  expected: 'evaluation-event-kind' | 'fill-side' | 'string',
  value: unknown,
  index?: number,
  eventKind?: EvaluationEvent['kind'],
): LedgerPlanFailureDetail => ({
  kind: 'input-value-invalid',
  field,
  expected,
  actualType: actualType(value),
  ...(typeof value === 'string' ? { value } : {}),
  ...(index === undefined ? {} : { index }),
  ...(eventKind === undefined ? {} : { eventKind }),
})

const requireString = (
  field: LedgerPlanInputField,
  value: unknown,
  index?: number,
  eventKind?: EvaluationEvent['kind'],
): Result.Result<string, LedgerPlanFailureDetail> =>
  typeof value === 'string'
    ? Result.succeed(value)
    : failLedgerPlan(invalidInputValue(field, 'string', value, index, eventKind))

const parseAmount = (
  field: LedgerPlanAmountField,
  value: unknown,
  eventId?: string,
): Result.Result<bigint, LedgerPlanFailureDetail> =>
  Result.mapError(
    Result.try(() => BigInt(value as string)),
    (cause): LedgerPlanFailureDetail => ({
      kind: 'amount-parse-failed',
      field,
      actualType: actualType(value),
      ...(typeof value === 'string' ? { value } : {}),
      ...(eventId === undefined ? {} : { eventId }),
      cause,
    }),
  )

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

const snapshotEvent = (
  event: unknown,
  eventIndex: number,
  access: InputAccessContext,
): Result.Result<EvaluationEvent, LedgerPlanFailureDetail> => {
  const inspected = Result.mapError(
    Result.try(() => {
      access.field = 'event.kind'
      access.eventIndex = eventIndex
      const source = event as Record<PropertyKey, unknown>
      const kind = source.kind
      access.eventKind =
        kind === 'decision' || kind === 'fill' || kind === 'fee' || kind === 'cash-yield' ? kind : undefined

      return { source, kind, prototype: Object.getPrototypeOf(source), properties: Reflect.ownKeys(source) }
    }),
    (cause) => inputAccessFailure(access, cause),
  )
  if (Result.isFailure(inspected)) return Result.fail(inspected.failure)
  const { source, kind, prototype, properties } = inspected.success
  if (prototype !== Object.prototype && prototype !== null) {
    return failLedgerPlan(inputAccessFailure(access, new TypeError('ledger-plan event must be a plain object')))
  }
  const entries: [string, unknown][] = []
  for (const property of properties) {
    access.field = eventInputField(kind, property)
    if (typeof property !== 'string') {
      return failLedgerPlan(inputAccessFailure(access, new TypeError('ledger-plan event must not contain symbol keys')))
    }
    const descriptorResult = Result.mapError(
      Result.try(() => Object.getOwnPropertyDescriptor(source, property)),
      (cause) => inputAccessFailure(access, cause),
    )
    if (Result.isFailure(descriptorResult)) return Result.fail(descriptorResult.failure)
    const descriptor = descriptorResult.success
    if (descriptor?.enumerable !== true || !('value' in descriptor)) {
      return failLedgerPlan(
        inputAccessFailure(access, new TypeError('ledger-plan event properties must be enumerable data properties')),
      )
    }
    entries.push([property, descriptor.value])
  }
  return Result.succeed(Object.fromEntries(entries) as unknown as EvaluationEvent)
}

const requireEventKind = (
  event: EvaluationEvent,
  eventIndex: number,
): Result.Result<EvaluationEvent['kind'], LedgerPlanFailureDetail> => {
  const kind = (event as { readonly kind: unknown }).kind
  return kind === 'decision' || kind === 'fill' || kind === 'fee' || kind === 'cash-yield'
    ? Result.succeed(kind)
    : failLedgerPlan(invalidInputValue('event.kind', 'evaluation-event-kind', kind, eventIndex))
}

const requireFillSide = (
  value: unknown,
  eventIndex: number,
): Result.Result<FillEvent['side'], LedgerPlanFailureDetail> =>
  value === 'buy' || value === 'sell'
    ? Result.succeed(value)
    : failLedgerPlan(invalidInputValue('fill.side', 'fill-side', value, eventIndex, 'fill'))

const decodeEvents = (
  rawEvents: readonly unknown[],
  access: InputAccessContext,
): Result.Result<Pick<DecodedLedgerInput, 'eventCount' | 'fills' | 'fees' | 'cashYields'>, LedgerPlanFailureDetail> =>
  Result.gen(function* () {
    const fills: DecodedFillEvent[] = []
    const fees: DecodedFeeEvent[] = []
    const cashYields: DecodedCashYieldEvent[] = []
    for (const [eventIndex, rawEvent] of rawEvents.entries()) {
      const event = yield* snapshotEvent(rawEvent, eventIndex, access)
      const kind = yield* requireEventKind(event, eventIndex)
      if (kind === 'fill') {
        const fill = event as FillEvent
        const id = yield* requireString('fill.id', fill.id, eventIndex, kind)
        const symbol = yield* requireString('fill.symbol', fill.symbol, eventIndex, kind)
        const side = yield* requireFillSide(fill.side, eventIndex)
        const notionalMicros = yield* parseAmount('fill.notionalMicros', fill.notionalMicros, id)
        const costBasisMicros = yield* parseAmount('fill.costBasisMicros', fill.costBasisMicros, id)
        fills.push({ event: fill, id, symbol, side, notionalMicros, costBasisMicros })
      } else if (kind === 'fee') {
        const fee = event as FeeEvent
        const id = yield* requireString('fee.id', fee.id, eventIndex, kind)
        const totalMicros = yield* parseAmount('fee.totalMicros', fee.totalMicros, id)
        fees.push({ event: fee, id, totalMicros })
      } else if (kind === 'cash-yield') {
        const cashYield = event as CashYieldEvent
        const id = yield* requireString('cashYield.id', cashYield.id, eventIndex, kind)
        const amountMicros = yield* parseAmount('cashYield.amountMicros', cashYield.amountMicros, id)
        cashYields.push({ event: cashYield, id, amountMicros })
      }
    }
    return { eventCount: rawEvents.length, fills, fees, cashYields }
  })

export const decodeLedgerInput = (input: unknown): Result.Result<DecodedLedgerInput, LedgerPlanFailureDetail> => {
  let access: InputAccessContext = { field: 'runId' }
  const snapshot = Result.mapError(
    Result.try(() => {
      const source = input as {
        readonly runId: unknown
        readonly initialCapitalMicros: unknown
        readonly inputManifest: { readonly symbols: readonly { readonly symbol: unknown }[] }
        readonly events: readonly unknown[]
      }
      access = { field: 'runId' }
      const runId = source.runId
      access = { field: 'initialCapitalMicros' }
      const initialCapitalMicros = source.initialCapitalMicros
      access = { field: 'inputManifest.symbols' }
      const rawSymbols = [...source.inputManifest.symbols]
      const symbols = rawSymbols.map((coverage, index) => {
        access = { field: 'inputManifest.symbol', eventIndex: index }
        return coverage.symbol
      })
      access = { field: 'events' }
      return { runId, initialCapitalMicros, symbols, events: [...source.events] }
    }),
    (cause) => inputAccessFailure(access, cause),
  )
  if (Result.isFailure(snapshot)) return Result.fail(snapshot.failure)

  return Result.gen(function* () {
    const runId = yield* requireString('runId', snapshot.success.runId)
    const initialCapitalMicros = yield* parseAmount('initialCapitalMicros', snapshot.success.initialCapitalMicros)
    const inventorySymbols = yield* Result.all(
      snapshot.success.symbols.map((symbol, index) => requireString('inputManifest.symbol', symbol, index)),
    )
    const events = yield* decodeEvents(snapshot.success.events, access)
    return { runId, initialCapitalMicros, inventorySymbols, ...events }
  })
}
