import type { EventType } from '../proto/temporal/api/enums/v1/event_type_pb'

import type { WorkflowCommandIntent } from './commands'
import { WorkflowNondeterminismError } from './errors'

export interface WorkflowRetryPolicyInput {
  readonly initialIntervalMs?: number
  readonly backoffCoefficient?: number
  readonly maximumIntervalMs?: number
  readonly maximumAttempts?: number
  readonly nonRetryableErrorTypes?: string[]
}

export interface WorkflowCommandHistoryEntryMetadata {
  readonly eventId?: string | null
  readonly eventType?: EventType
  readonly workflowTaskCompletedEventId?: string | null
  readonly attempt?: number
}

export interface WorkflowCommandHistoryEntry {
  readonly intent: WorkflowCommandIntent
  readonly metadata?: WorkflowCommandHistoryEntryMetadata
}

export interface WorkflowDeterminismFailureMetadata {
  readonly eventId?: string | null
  readonly eventType?: EventType
  readonly failureType?: string
  readonly failureMessage?: string
  readonly retryState?: number
}

export interface WorkflowDeterminismState {
  readonly commandHistory: readonly WorkflowCommandHistoryEntry[]
  readonly randomValues: readonly number[]
  readonly timeValues: readonly number[]
  readonly failureMetadata?: WorkflowDeterminismFailureMetadata
}

export interface DeterminismGuardOptions {
  readonly allowBypass?: boolean
  readonly previousState?: WorkflowDeterminismState
}

export type DeterminismGuardSnapshot = {
  commandHistory: WorkflowCommandHistoryEntry[]
  randomValues: number[]
  timeValues: number[]
  failureMetadata?: WorkflowDeterminismFailureMetadata
}

export const snapshotToDeterminismState = (snapshot: DeterminismGuardSnapshot): WorkflowDeterminismState => ({
  commandHistory: snapshot.commandHistory.map((entry) => ({
    intent: entry.intent,
    metadata: entry.metadata ? { ...entry.metadata } : undefined,
  })),
  randomValues: [...snapshot.randomValues],
  timeValues: [...snapshot.timeValues],
  failureMetadata: snapshot.failureMetadata ? { ...snapshot.failureMetadata } : undefined,
})

export type RecordedCommandKind = 'new' | 'replay'

export class DeterminismGuard {
  readonly #allowBypass: boolean
  readonly #previous: WorkflowDeterminismState | undefined
  readonly snapshot: DeterminismGuardSnapshot
  #commandIndex = 0
  #randomIndex = 0
  #timeIndex = 0

  constructor(options: DeterminismGuardOptions = {}) {
    this.#allowBypass = options.allowBypass ?? false
    this.#previous = options.previousState
    this.snapshot = {
      commandHistory: [],
      randomValues: [],
      timeValues: [],
    }
  }

  recordCommand(intent: WorkflowCommandIntent): RecordedCommandKind {
    let kind: RecordedCommandKind = 'new'
    if (!this.#allowBypass && this.#previous) {
      const previousEntry = this.#previous.commandHistory[this.#commandIndex]
      if (previousEntry) {
        const expected = previousEntry.intent
        if (!expected) {
          throw new WorkflowNondeterminismError('Workflow emitted new command on replay', {
            hint: `commandIndex=${this.#commandIndex}`,
            received: intent,
          })
        }
        if (!intentsEqual(expected, intent)) {
          throw new WorkflowNondeterminismError('Workflow command intent mismatch during replay', {
            hint: `commandIndex=${this.#commandIndex}`,
            expected,
            received: intent,
          })
        }
        kind = 'replay'
      }
    }
    this.snapshot.commandHistory.push({ intent })
    this.#commandIndex += 1
    return kind
  }

  nextRandom(generate: () => number): number {
    if (!this.#allowBypass && this.#previous) {
      const expected = this.#previous.randomValues[this.#randomIndex]
      if (expected === undefined) {
        throw new WorkflowNondeterminismError('Workflow generated new random value during replay', {
          hint: `randomIndex=${this.#randomIndex}`,
        })
      }
      this.snapshot.randomValues.push(expected)
      this.#randomIndex += 1
      return expected
    }
    const value = generate()
    if (!Number.isFinite(value)) {
      throw new WorkflowNondeterminismError('Random value must be a finite number', {
        received: value,
      })
    }
    this.snapshot.randomValues.push(value)
    this.#randomIndex += 1
    return value
  }

  nextTime(generate: () => number): number {
    if (!this.#allowBypass && this.#previous) {
      const expected = this.#previous.timeValues[this.#timeIndex]
      if (expected === undefined) {
        throw new WorkflowNondeterminismError('Workflow generated new time value during replay', {
          hint: `timeIndex=${this.#timeIndex}`,
        })
      }
      this.snapshot.timeValues.push(expected)
      this.#timeIndex += 1
      return expected
    }
    const value = generate()
    if (!Number.isFinite(value)) {
      throw new WorkflowNondeterminismError('Time value must be a finite number', {
        received: value,
      })
    }
    this.snapshot.timeValues.push(value)
    this.#timeIndex += 1
    return value
  }
}

export const intentsEqual = (a: WorkflowCommandIntent | undefined, b: WorkflowCommandIntent | undefined): boolean => {
  if (!a || !b) {
    return a === b
  }
  if (a.kind !== b.kind) {
    return false
  }
  if (a.sequence !== b.sequence) {
    return false
  }
  const signatureA = stableIntentSignature(a)
  const signatureB = stableIntentSignature(b)
  return signatureA === signatureB
}

const stableIntentSignature = (intent: WorkflowCommandIntent): string =>
  stableStringify(intent, (_key, value) => {
    if (typeof value === 'bigint') {
      return value.toString()
    }
    if (value instanceof Uint8Array) {
      return Buffer.from(value).toString('base64')
    }
    if (value && typeof value === 'object' && 'kind' in value && 'sequence' in value) {
      return value
    }
    return value
  })

type JsonReplacer = (this: unknown, key: string, value: unknown) => unknown

const stableStringify = (value: unknown, replacer?: JsonReplacer): string => {
  const seen = new WeakSet<object>()
  const stable = (key: string, input: unknown): unknown => {
    if (replacer) {
      // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
      input = replacer.call(this, key, input)
    }
    if (!input || typeof input !== 'object') {
      return input
    }
    if (seen.has(input as object)) {
      return '[Circular]'
    }
    seen.add(input as object)
    if (Array.isArray(input)) {
      return input.map((item, index) => stable(String(index), item))
    }
    const entries = Object.entries(input as Record<string, unknown>).map(([k, v]) => [k, stable(k, v)] as const)
    entries.sort(([lhs], [rhs]) => lhs.localeCompare(rhs))
    return Object.fromEntries(entries)
  }
  return JSON.stringify(stable('', value))
}
