import * as S from '@effect/schema/Schema'
import { formatErrorSync } from '@effect/schema/TreeFormatter'
import * as Either from 'effect/Either'

const ToolEventEnvelopeSchema = S.Struct({
  id: S.optional(S.String),
  toolKind: S.optional(S.String),
  status: S.optional(S.String),
  title: S.optional(S.String),
  delta: S.optional(S.Unknown),
  detail: S.optional(S.Unknown),
  data: S.optional(S.Unknown),
  changes: S.optional(S.Unknown),
})

type ToolEventEnvelope = S.Schema.Type<typeof ToolEventEnvelopeSchema>

export type ToolEvent = {
  id: string
  toolKind: string
  status?: string
  title?: string
  delta?: string
  detail?: string
  data?: Record<string, unknown>
  changes?: unknown[]
}

const asNonEmptyString = (value: unknown): string | undefined =>
  typeof value === 'string' && value.length > 0 ? value : undefined

const normalizeDelta = (value: unknown): string | undefined => {
  if (typeof value === 'string') return value.length > 0 ? value : undefined
  if (value == null || typeof value === 'function') return undefined
  return String(value)
}

const asRecord = (value: unknown): Record<string, unknown> | undefined => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined
  return value as Record<string, unknown>
}

const pickChanges = (envelope: ToolEventEnvelope): unknown[] | undefined => {
  const data = asRecord(envelope.data)
  const dataChanges = data?.changes
  if (Array.isArray(dataChanges)) return dataChanges
  return Array.isArray(envelope.changes) ? envelope.changes : undefined
}

export const decodeToolEvent = (input: unknown, fallbackId: string): Either.Either<ToolEvent, string> => {
  const decoded = S.decodeUnknownEither(ToolEventEnvelopeSchema)(input)
  if (Either.isLeft(decoded)) {
    return Either.left(formatErrorSync(decoded.left))
  }

  const envelope = decoded.right
  const data = asRecord(envelope.data)
  const id = asNonEmptyString(envelope.id) ?? fallbackId
  const toolKind = asNonEmptyString(envelope.toolKind) ?? 'tool'

  return Either.right({
    id,
    toolKind,
    status: asNonEmptyString(envelope.status),
    title: asNonEmptyString(envelope.title),
    delta: normalizeDelta(envelope.delta),
    detail: asNonEmptyString(envelope.detail),
    data,
    changes: pickChanges(envelope),
  })
}
