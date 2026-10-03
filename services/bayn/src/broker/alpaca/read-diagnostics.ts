import { Cause, Clock, Effect, Ref, Result, Schema } from 'effect'

import { canonicalHashV1Result } from '../../hash'
import { IsoDateSchema, UtcSourceTimestampSchema } from '../../schemas'
import type { BrokerIdentity } from '../identity'
import type { ReadEvidence } from './model'

export const diagnosticLimits = { identities: 128, records: 32, bytes: 16_384, intervalMs: 60_000 } as const
type JsonType = 'string' | 'number' | 'boolean' | 'object' | 'array' | 'undefined' | 'accessor'
type Field =
  | { readonly state: 'absent' | 'null' }
  | { readonly state: 'invalid' | 'unrecognized'; readonly type: JsonType }
  | { readonly state: 'reported'; readonly type: 'string'; readonly value: string }
type Fields = Readonly<Record<string, Field>>
interface FeeMetadata {
  readonly activityHash: string
  readonly reportedDate: string
  readonly fields: Fields
}
export type ReadDiagnostic =
  | { readonly endpoint: '/v2/account'; readonly fields: Fields }
  | {
      readonly endpoint: '/v2/account/activities/FEE'
      readonly fees: readonly FeeMetadata[]
      readonly omitted: number
    }

const object = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)
const ownData = (raw: object, name: string) => {
  const descriptor = Object.getOwnPropertyDescriptor(raw, name)
  if (descriptor === undefined) return { state: 'absent' } as const
  if (!Object.hasOwn(descriptor, 'value')) return { state: 'accessor' } as const
  return { state: 'value', value: descriptor.value as unknown } as const
}
const jsonType = (value: unknown): JsonType => {
  if (Array.isArray(value)) return 'array'
  if (typeof value === 'string') return 'string'
  if (typeof value === 'number') return 'number'
  if (typeof value === 'boolean') return 'boolean'
  return typeof value === 'undefined' ? 'undefined' : 'object'
}
const field = (raw: Record<string, unknown>, name: string, valid: (value: string) => boolean): Field => {
  const property = ownData(raw, name)
  if (property.state === 'absent') return { state: 'absent' }
  if (property.state === 'accessor') return { state: 'invalid', type: 'accessor' }
  const value = property.value
  if (value === null) return { state: 'null' }
  if (typeof value !== 'string' || value.length > 64) return { state: 'invalid', type: jsonType(value) }
  return valid(value) ? { state: 'reported', type: 'string', value } : { state: 'unrecognized', type: 'string' }
}
// These are lexical allowlists for observations, never provider settlement/booking rules.
const statuses = new Set(['executed', 'pending', 'canceled', 'cancelled'])
const subtypes = new Set(['REG', 'TAF', 'CAT', 'ORF', 'OCC', 'NRV', 'NRC', 'LCT', 'COM', 'ADR', 'OCOM', 'BSWP', 'LOC'])
const decimal = (value: string): boolean => /^-?(?:0|[1-9][0-9]{0,38})(?:\.[0-9]{1,18})?$/.test(value)
const date = Schema.is(IsoDateSchema)
const instant = Schema.is(UtcSourceTimestampSchema)
const hash = (domain: string, value: unknown): string | undefined => {
  const result = canonicalHashV1Result({ domain, value })
  return Result.isSuccess(result) ? result.success : undefined
}
const description = (raw: Record<string, unknown>): Field => {
  const property = ownData(raw, 'description')
  if (property.state === 'absent') return { state: 'absent' }
  if (property.state === 'accessor') return { state: 'invalid', type: 'accessor' }
  const value = property.value
  if (value === null) return { state: 'null' }
  if (typeof value !== 'string' || value.length > 512) return { state: 'invalid', type: jsonType(value) }
  const category = /^(REG|TAF|CAT) fee(?:\s|$)/.exec(value)?.[1]
  return category === undefined
    ? { state: 'unrecognized', type: 'string' }
    : { state: 'reported', type: 'string', value: category }
}

/** Only projects fields already present in the existing response; never retains raw text. */
export const projectReadDiagnostic = (operation: string, raw: unknown): ReadDiagnostic | undefined => {
  const projected = Result.try({
    try: (): ReadDiagnostic | undefined => {
      if (operation === 'account' && object(raw))
        return {
          endpoint: '/v2/account',
          fields: {
            accrued_fees: field(raw, 'accrued_fees', decimal),
            pending_reg_taf_fees: field(raw, 'pending_reg_taf_fees', decimal),
          },
        }
      if (operation !== 'fee-activities' || !Array.isArray(raw)) return undefined
      const length = ownData(raw, 'length')
      if (
        length.state !== 'value' ||
        typeof length.value !== 'number' ||
        !Number.isSafeInteger(length.value) ||
        length.value < 0
      )
        return undefined
      const fees: FeeMetadata[] = []
      let omitted = Math.max(0, length.value - diagnosticLimits.identities)
      for (let index = 0; index < Math.min(length.value, diagnosticLimits.identities); index += 1) {
        const item = ownData(raw, String(index))
        if (item.state !== 'value' || !object(item.value)) {
          omitted += 1
          continue
        }
        const row = item.value
        const id = ownData(row, 'id')
        const reportedDate = field(row, 'date', date)
        if (
          id.state !== 'value' ||
          typeof id.value !== 'string' ||
          id.value.length > 128 ||
          reportedDate.state !== 'reported'
        ) {
          omitted += 1
          continue
        }
        const activityHash = hash('bayn.fee-diagnostic-activity.v1', id.value)
        if (activityHash === undefined) {
          omitted += 1
          continue
        }
        fees.push({
          activityHash,
          reportedDate: reportedDate.value,
          fields: {
            date: reportedDate,
            status: field(row, 'status', (value) => statuses.has(value)),
            activity_subtype: field(row, 'activity_subtype', (value) => subtypes.has(value)),
            entry_sub_type: field(row, 'entry_sub_type', (value) => subtypes.has(value)),
            settle_date: field(row, 'settle_date', date),
            system_date: field(row, 'system_date', date),
            executed_at: field(row, 'executed_at', instant),
            transaction_time: field(row, 'transaction_time', instant),
            descriptionCategoryNonAuthoritative: description(row),
          },
        })
      }
      return { endpoint: '/v2/account/activities/FEE', fees, omitted }
    },
    catch: () => undefined,
  })
  return Result.isSuccess(projected) ? projected.success : undefined
}

interface Evidence {
  readonly requestIdHash: string
  readonly responseHash: string
  readonly observedAt: string
}
interface Entry<A> {
  readonly metadata: A
  readonly evidence: Evidence
  readonly fingerprint: string
  readonly emitted: string | undefined
}
interface State {
  readonly fees: ReadonlyMap<string, Entry<FeeMetadata>>
  readonly account?: Entry<Fields>
  readonly omitted: number
  readonly retentionTruncated: boolean
  readonly omissionReported: boolean
  readonly lastEmittedAt: number
}
export interface DiagnosticEvent {
  readonly schemaVersion: 'bayn.broker-read-diagnostic.v1'
  readonly provider: BrokerIdentity['provider']
  readonly environment: BrokerIdentity['environment']
  readonly identityHash: string
  readonly account?: { readonly endpoint: '/v2/account'; readonly fields: Fields; readonly evidence: Evidence }
  readonly fees: readonly (FeeMetadata & {
    readonly endpoint: '/v2/account/activities/FEE'
    readonly evidence: Evidence
  })[]
  readonly omittedRecords: number
  readonly pendingRecords: number
  readonly incomplete: boolean
  readonly retentionTruncated: boolean
}
const newestFirst = (left: Entry<FeeMetadata>, right: Entry<FeeMetadata>): number =>
  right.metadata.reportedDate.localeCompare(left.metadata.reportedDate) ||
  left.metadata.activityHash.localeCompare(right.metadata.activityHash)

/** Diagnostic failures cannot replace a provider result; interruption remains interruption. */
const diagnosticOnly = (effect: Effect.Effect<void>): Effect.Effect<void> =>
  effect.pipe(Effect.catchCause((cause) => (Cause.hasInterrupts(cause) ? Effect.failCause(cause) : Effect.void)))

export const makeReadDiagnostics = (
  identity: BrokerIdentity,
  emit: (event: DiagnosticEvent) => Effect.Effect<void> = (event) =>
    Effect.logInfo('Broker response diagnostic evidence').pipe(Effect.annotateLogs({ brokerReadDiagnostic: event })),
) =>
  Effect.gen(function* () {
    const state = yield* Ref.make<State>({
      fees: new Map(),
      omitted: 0,
      retentionTruncated: false,
      omissionReported: false,
      lastEmittedAt: yield* Clock.currentTimeMillis,
    })
    return (diagnostic: ReadDiagnostic | undefined, read: ReadEvidence): Effect.Effect<void> => {
      if (diagnostic === undefined) return Effect.void
      return diagnosticOnly(
        Effect.gen(function* () {
          const now = yield* Clock.currentTimeMillis
          const event = yield* Ref.modify(state, (current): [DiagnosticEvent | undefined, State] => {
            const requestIdHash = hash('bayn.fee-diagnostic-request.v1', read.requestId)
            if (requestIdHash === undefined) return [undefined, current]
            const evidence = { requestIdHash, responseHash: read.contentHash, observedAt: read.observedAt }
            let account = current.account
            const fees = new Map(current.fees)
            let omitted = current.omitted
            if (diagnostic.endpoint === '/v2/account') {
              const fingerprint = hash('bayn.account-diagnostic.v1', diagnostic.fields)
              if (fingerprint !== undefined)
                account = { metadata: diagnostic.fields, evidence, fingerprint, emitted: account?.emitted }
            } else {
              omitted = Math.min(Number.MAX_SAFE_INTEGER, omitted + diagnostic.omitted)
              for (const metadata of diagnostic.fees) {
                const fingerprint = hash('bayn.fee-diagnostic.v1', metadata)
                if (fingerprint !== undefined)
                  fees.set(metadata.activityHash, {
                    metadata,
                    evidence,
                    fingerprint,
                    emitted: fees.get(metadata.activityHash)?.emitted,
                  })
              }
            }
            const ordered = [...fees.values()].sort(newestFirst)
            for (const entry of ordered.slice(diagnosticLimits.identities)) {
              fees.delete(entry.metadata.activityHash)
              omitted = Math.min(Number.MAX_SAFE_INTEGER, omitted + 1)
            }
            const next: State = {
              fees,
              ...(account === undefined ? {} : { account }),
              omitted,
              retentionTruncated: current.retentionTruncated || omitted > 0,
              omissionReported: current.omissionReported,
              lastEmittedAt: current.lastEmittedAt,
            }
            if (now - current.lastEmittedAt < diagnosticLimits.intervalMs) return [undefined, next]
            const pending = [...fees.values()].filter((entry) => entry.fingerprint !== entry.emitted).sort(newestFirst)
            const accountChanged = account !== undefined && account.fingerprint !== account.emitted
            if (pending.length === 0 && !accountChanged && (omitted === 0 || current.omissionReported))
              return [undefined, { ...next, omitted: 0 }]
            const selected = pending.slice(0, diagnosticLimits.records)
            const material = (): DiagnosticEvent => ({
              schemaVersion: 'bayn.broker-read-diagnostic.v1',
              provider: identity.provider,
              environment: identity.environment,
              identityHash: identity.identityHash,
              ...(accountChanged && account !== undefined
                ? { account: { endpoint: '/v2/account', fields: account.metadata, evidence: account.evidence } }
                : {}),
              fees: selected.map(({ metadata, evidence }) => ({
                ...metadata,
                endpoint: '/v2/account/activities/FEE',
                evidence,
              })),
              omittedRecords: omitted,
              pendingRecords: pending.length - selected.length,
              incomplete: next.retentionTruncated || pending.length > selected.length,
              retentionTruncated: next.retentionTruncated,
            })
            let output = material()
            while (
              new TextEncoder().encode(JSON.stringify(output)).length > diagnosticLimits.bytes &&
              selected.length > 0
            ) {
              selected.pop()
              output = material()
            }
            if (new TextEncoder().encode(JSON.stringify(output)).length > diagnosticLimits.bytes)
              return [undefined, next]
            for (const entry of selected)
              fees.set(entry.metadata.activityHash, { ...entry, emitted: entry.fingerprint })
            return [
              output,
              {
                ...next,
                ...(accountChanged && account !== undefined
                  ? { account: { ...account, emitted: account.fingerprint } }
                  : {}),
                omitted: 0,
                omissionReported: current.omissionReported || omitted > 0,
                lastEmittedAt: now,
              },
            ]
          })
          if (event !== undefined) yield* emit(event)
        }),
      )
    }
  })
