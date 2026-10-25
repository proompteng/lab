import { createHash } from 'node:crypto'

import type {
  AgentsAgentRunProjectionAuthorityClaim,
  AgentsAgentRunProjectionAuthorityResult,
  AgentsProjectionAuthorityState,
  AgentsProjectionValueGate,
} from '@proompteng/agent-contracts'
import { Context, Data, Effect, Layer } from 'effect'

import { errorResponse, okResponse } from '../http'
import { asRecord, asString } from '../primitives'

import { AgentRunStorageError, agentRunSubmitStatus, describeAgentRunSubmitError } from './agent-run-errors'
import {
  AgentRunStoreService,
  makeAgentRunStoreLayer,
  type AgentRunListInput,
  type AgentRunRecord,
  type AgentRunsApiStore,
} from './agent-run-store'

type ProjectionAuthorityRequest = {
  agentName: string | null
  includeTerminalAudit: boolean
  limit: number
}

type ProjectionAuthorityClockServiceDefinition = {
  readonly now: Effect.Effect<Date>
}

export class ProjectionAuthorityClockService extends Context.Tag('agents/ProjectionAuthorityClockService')<
  ProjectionAuthorityClockService,
  ProjectionAuthorityClockServiceDefinition
>() {}

export type AgentRunProjectionAuthorityDeps = {
  storeFactory: () => AgentRunsApiStore
  now?: () => Date
}

export class AgentRunProjectionAuthorityInvalidRequestError extends Data.TaggedError(
  'AgentRunProjectionAuthorityInvalidRequestError',
)<{
  readonly message: string
}> {}

type AgentRunProjectionAuthorityError = AgentRunStorageError | AgentRunProjectionAuthorityInvalidRequestError

const SCHEMA_VERSION = 'agents.agentrun-projection-authority.v1' as const
const DEFAULT_AUTHORITY_BUDGET_SECONDS = 6 * 60 * 60

export const AGENT_RUN_ACTIVE_PROJECTION_STATUSES = new Set([
  'pending',
  'queued',
  'started',
  'submitted',
  'running',
  'in_progress',
  'progress',
  'progressing',
])

const TERMINAL_STATUSES = new Set([
  'succeeded',
  'success',
  'completed',
  'complete',
  'failed',
  'failure',
  'error',
  'errored',
  'cancelled',
  'canceled',
  'timed_out',
  'timeout',
])

const activeProjectionStatusQueryValues = () => [
  ...AGENT_RUN_ACTIVE_PROJECTION_STATUSES,
  ...[...AGENT_RUN_ACTIVE_PROJECTION_STATUSES].map((status) =>
    status.replace(/(^|_)([a-z])/g, (_, prefix, char: string) => `${prefix}${char.toUpperCase()}`),
  ),
  ...[...AGENT_RUN_ACTIVE_PROJECTION_STATUSES].map((status) => status.toUpperCase()),
]

const parseLimit = (value: string | null) => {
  if (!value) return 100
  const parsed = Number.parseInt(value, 10)
  if (!Number.isFinite(parsed) || parsed <= 0) return 100
  return Math.min(parsed, 500)
}

const parseBoolean = (value: string | null, fallback = false) => {
  const normalized = value?.trim().toLowerCase()
  if (!normalized) return fallback
  if (['1', 'true', 'yes', 'on', 'enabled'].includes(normalized)) return true
  if (['0', 'false', 'no', 'off', 'disabled'].includes(normalized)) return false
  return fallback
}

const normalizeStatus = (value: string | null | undefined) =>
  (value ?? 'unknown')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_.:-]+/g, '_')

const hashJson = (value: unknown, length = 16) =>
  createHash('sha256').update(JSON.stringify(value)).digest('hex').slice(0, length)

const claimId = (parts: unknown[]) => `projection-claim:agentrun_execution:${hashJson(parts, 14)}`

const parseDate = (value: string | null | undefined) => {
  if (!value) return null
  const date = new Date(value)
  return Number.isFinite(date.getTime()) ? date : null
}

const addSeconds = (value: Date, seconds: number) => new Date(value.getTime() + seconds * 1000)

const toIso = (value: unknown): string | null => {
  if (!value) return null
  const date = value instanceof Date ? value : new Date(String(value))
  return Number.isFinite(date.getTime()) ? date.toISOString() : null
}

const readNumber = (value: unknown): number | null => {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value === 'string' && value.trim().length > 0) {
    const parsed = Number(value)
    return Number.isFinite(parsed) ? parsed : null
  }
  return null
}

const readNestedNumber = (payload: Record<string, unknown>, keys: string[]) => {
  for (const key of keys) {
    const direct = readNumber(payload[key])
    if (direct !== null) return direct
  }

  const spec = asRecord(payload.spec) ?? {}
  for (const key of keys) {
    const nested = readNumber(spec[key])
    if (nested !== null) return nested
  }

  const parameters = asRecord(payload.parameters) ?? {}
  for (const key of keys) {
    const nested = readNumber(parameters[key])
    if (nested !== null) return nested
  }

  return null
}

const authorityBudgetSeconds = (payload: Record<string, unknown>) => {
  const timeoutSeconds =
    readNestedNumber(payload, ['timeoutSeconds', 'timeout_seconds', 'maxRuntimeSeconds', 'max_runtime_seconds']) ??
    (readNestedNumber(payload, ['timeoutMs', 'timeout_ms']) ?? 0) / 1000
  const scheduleSeconds =
    readNestedNumber(payload, ['scheduleIntervalSeconds', 'schedule_interval_seconds', 'everySeconds']) ??
    (readNestedNumber(payload, ['scheduleIntervalMs', 'schedule_interval_ms', 'everyMs']) ?? 0) / 1000

  return Math.max(DEFAULT_AUTHORITY_BUDGET_SECONDS, timeoutSeconds, scheduleSeconds * 2)
}

const uniqueStrings = (values: Array<string | null | undefined>) => [
  ...new Set(values.filter((value): value is string => Boolean(value && value.trim().length > 0))),
]

const buildClaim = (
  input: Omit<AgentsAgentRunProjectionAuthorityClaim, 'claim_id'>,
): AgentsAgentRunProjectionAuthorityClaim => ({
  claim_id: claimId([input.source_ref, input.projection_ref, input.authority_state]),
  ...input,
  reason_codes: uniqueStrings(input.reason_codes).map(normalizeStatus),
})

const projectionRefFor = (record: AgentRunRecord) => `agent_runs:${record.id}`

const liveAuthorityRefFor = (record: AgentRunRecord) =>
  record.externalRunId
    ? `agents-service-agentrun:${record.externalRunId}`
    : `agents-service-agent-run-record:${record.id}`

export const classifyAgentRunProjectionAuthorityClaim = (
  record: AgentRunRecord,
  now: Date,
): AgentsAgentRunProjectionAuthorityClaim | null => {
  const status = normalizeStatus(record.status)
  const payload = asRecord(record.payload) ?? {}
  const observedAt = toIso(record.updatedAt) ?? toIso(record.createdAt)
  const observedDate = parseDate(observedAt) ?? now
  const projectionRef = projectionRefFor(record)
  const liveAuthorityRef = liveAuthorityRefFor(record)

  if (TERMINAL_STATUSES.has(status)) {
    return buildClaim({
      claim_class: 'agentrun_execution',
      source_ref: projectionRef,
      source_owner: record.agentName,
      lane: normalizeStatus(record.agentName),
      status,
      observed_at: observedAt,
      last_heartbeat_at: toIso(record.updatedAt),
      fresh_until: null,
      live_authority_ref: liveAuthorityRef,
      projection_ref: projectionRef,
      authority_state: 'terminal_audit',
      reason_codes: ['agents_service_agentrun_projection_terminal_audit'],
      value_gates: ['failed_agentrun_rate', 'handoff_evidence_quality'],
    })
  }

  const freshUntil = addSeconds(observedDate, authorityBudgetSeconds(payload))
  const authorityState: AgentsProjectionAuthorityState =
    AGENT_RUN_ACTIVE_PROJECTION_STATUSES.has(status) && freshUntil.getTime() >= now.getTime()
      ? 'authoritative'
      : AGENT_RUN_ACTIVE_PROJECTION_STATUSES.has(status)
        ? 'stale_foreclosed'
        : 'grace'
  const reasonCodes =
    authorityState === 'authoritative'
      ? ['agents_service_agentrun_projection_current']
      : authorityState === 'stale_foreclosed'
        ? ['agents_service_agentrun_projection_not_renewed']
        : ['agents_service_agentrun_projection_inside_grace_budget']

  return buildClaim({
    claim_class: 'agentrun_execution',
    source_ref: projectionRef,
    source_owner: record.agentName,
    lane: normalizeStatus(record.agentName),
    status,
    observed_at: observedAt,
    last_heartbeat_at: toIso(record.updatedAt),
    fresh_until: freshUntil.toISOString(),
    live_authority_ref: liveAuthorityRef,
    projection_ref: projectionRef,
    authority_state: authorityState,
    reason_codes: reasonCodes,
    value_gates: ['failed_agentrun_rate', 'ready_status_truth', 'manual_intervention_count'],
  })
}

const parseRequest = (
  request: Request,
): Effect.Effect<ProjectionAuthorityRequest, AgentRunProjectionAuthorityInvalidRequestError> =>
  Effect.gen(function* () {
    const url = new URL(request.url)
    const limit = parseLimit(url.searchParams.get('limit'))
    const agentName = asString(url.searchParams.get('agentName')) ?? asString(url.searchParams.get('agentId'))
    return {
      agentName,
      includeTerminalAudit: parseBoolean(url.searchParams.get('includeTerminalAudit'), false),
      limit,
    }
  })

const listAgentRunsEffect = (
  input: AgentRunListInput,
): Effect.Effect<unknown[], AgentRunStorageError, AgentRunStoreService> =>
  Effect.gen(function* () {
    const stores = yield* AgentRunStoreService
    return yield* Effect.acquireUseRelease(
      stores.open,
      (store) => stores.ready(store).pipe(Effect.zipRight(stores.listRuns(store, input))),
      stores.close,
    )
  })

const makeClockLayer = (now: () => Date = () => new Date()) =>
  Layer.succeed(ProjectionAuthorityClockService, {
    now: Effect.sync(now),
  })

export const makeAgentRunProjectionAuthorityLayer = (deps: AgentRunProjectionAuthorityDeps) =>
  Layer.merge(makeAgentRunStoreLayer(deps.storeFactory), makeClockLayer(deps.now))

const toAgentRunRecord = (value: unknown): AgentRunRecord | null => {
  const record = asRecord(value)
  if (!record) return null
  const id = asString(record.id)
  const agentName = asString(record.agentName)
  const deliveryId = asString(record.deliveryId)
  const provider = asString(record.provider) ?? 'unknown'
  const status = asString(record.status)
  if (!id || !agentName || !deliveryId || !status) return null
  return {
    id,
    agentName,
    deliveryId,
    provider,
    status,
    externalRunId: asString(record.externalRunId),
    payload: asRecord(record.payload) ?? {},
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
  }
}

export const getAgentRunProjectionAuthorityEffect = (
  request: Request,
): Effect.Effect<
  AgentsAgentRunProjectionAuthorityResult,
  AgentRunProjectionAuthorityError,
  AgentRunStoreService | ProjectionAuthorityClockService
> =>
  Effect.gen(function* () {
    const parsed = yield* parseRequest(request)
    const clock = yield* ProjectionAuthorityClockService
    const now = yield* clock.now
    const rows = yield* listAgentRunsEffect({
      agentName: parsed.agentName,
      statuses: parsed.includeTerminalAudit ? null : activeProjectionStatusQueryValues(),
      limit: parsed.limit,
    })
    const claims = rows
      .map(toAgentRunRecord)
      .filter((record): record is AgentRunRecord => record !== null)
      .map((record) => classifyAgentRunProjectionAuthorityClaim(record, now))
      .filter((claim): claim is AgentsAgentRunProjectionAuthorityClaim => claim !== null)
      .filter((claim) => parsed.includeTerminalAudit || claim.authority_state !== 'terminal_audit')

    return {
      ok: true,
      schemaVersion: SCHEMA_VERSION,
      generatedAt: now.toISOString(),
      total: claims.length,
      claims,
    }
  })

const errorStatus = (error: AgentRunProjectionAuthorityError) =>
  error instanceof AgentRunProjectionAuthorityInvalidRequestError ? 400 : agentRunSubmitStatus(error)

const errorDetails = (error: AgentRunProjectionAuthorityError) => {
  if (error instanceof AgentRunStorageError) {
    return { operation: error.operation }
  }
  return undefined
}

export const getAgentRunProjectionAuthorityHandler = async (
  request: Request,
  deps: AgentRunProjectionAuthorityDeps,
) => {
  const result = await Effect.runPromise(
    getAgentRunProjectionAuthorityEffect(request).pipe(
      Effect.provide(makeAgentRunProjectionAuthorityLayer(deps)),
      Effect.either,
    ),
  )
  if (result._tag === 'Right') return okResponse(result.right)
  return errorResponse(describeAgentRunSubmitError(result.left), errorStatus(result.left), errorDetails(result.left))
}

export const __test__ = {
  activeProjectionStatusQueryValues,
  authorityBudgetSeconds,
}
