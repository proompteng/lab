import type {
  AgentsAgentRunTerminalEvent,
  AgentsAgentRunTerminalEventAckInput,
  AgentsAgentRunTerminalEventAckResult,
  AgentsAgentRunTerminalEventsListResult,
} from '@proompteng/agent-contracts'
import { Context, Data, Effect, Layer } from 'effect'

import { errorResponse, okResponse, parseJsonBody } from '../http'
import { createKubernetesClient, RESOURCE_MAP, type KubernetesClient } from '../kube-types'
import { asRecord, asString, normalizeNamespace, readNested } from '../primitives'

type AgentRunTerminalEventsRequest = {
  namespace: string
  runIdPrefix: string | null
  consumer: string | null
  includeAcked: boolean
  limit: number
}

type TerminalEventRef = {
  namespace: string
  name: string
  uid: string
  phase: string
}

type AgentRunTerminalEventKubeOperation = 'create-client' | 'list' | 'get' | 'patch'

export class AgentRunTerminalEventInvalidRequestError extends Data.TaggedError(
  'AgentRunTerminalEventInvalidRequestError',
)<{
  readonly message: string
}> {}

export class AgentRunTerminalEventNotFoundError extends Data.TaggedError('AgentRunTerminalEventNotFoundError')<{
  readonly eventId: string
}> {}

export class AgentRunTerminalEventConflictError extends Data.TaggedError('AgentRunTerminalEventConflictError')<{
  readonly eventId: string
  readonly message: string
}> {}

export class AgentRunTerminalEventKubeError extends Data.TaggedError('AgentRunTerminalEventKubeError')<{
  readonly operation: AgentRunTerminalEventKubeOperation
  readonly namespace: string
  readonly name?: string
  readonly cause: unknown
}> {}

type AgentRunTerminalEventError =
  | AgentRunTerminalEventInvalidRequestError
  | AgentRunTerminalEventNotFoundError
  | AgentRunTerminalEventConflictError
  | AgentRunTerminalEventKubeError

type AgentRunTerminalEventKubeServiceShape = {
  readonly listAgentRuns: (
    namespace: string,
  ) => Effect.Effect<Record<string, unknown>[], AgentRunTerminalEventKubeError>
  readonly getAgentRun: (
    namespace: string,
    name: string,
  ) => Effect.Effect<Record<string, unknown> | null, AgentRunTerminalEventKubeError>
  readonly patchAgentRunAnnotations: (
    namespace: string,
    name: string,
    annotations: Record<string, string | null>,
  ) => Effect.Effect<Record<string, unknown>, AgentRunTerminalEventKubeError>
}

export class AgentRunTerminalEventKubeService extends Context.Tag('agents/AgentRunTerminalEventKubeService')<
  AgentRunTerminalEventKubeService,
  AgentRunTerminalEventKubeServiceShape
>() {}

export type AgentRunTerminalEventDeps = {
  kubeClient?: KubernetesClient
  kubeClientFactory?: () => KubernetesClient
}

const TERMINAL_PHASES = new Set(['succeeded', 'failed', 'cancelled'])
const ACK_ANNOTATION_PREFIX = 'agents.proompteng.ai/terminal-ack'
const DEFAULT_NAMESPACE = 'agents'

const parseLimit = (value: string | null) => {
  if (!value) return 100
  const parsed = Number(value)
  if (!Number.isFinite(parsed) || parsed <= 0) return 100
  return Math.min(Math.floor(parsed), 500)
}

const parseBoolean = (value: string | null, fallback = false) => {
  const normalized = value?.trim().toLowerCase()
  if (!normalized) return fallback
  if (['1', 'true', 'yes', 'on', 'enabled'].includes(normalized)) return true
  if (['0', 'false', 'no', 'off', 'disabled'].includes(normalized)) return false
  return fallback
}

const asArrayItems = (payload: Record<string, unknown>) => {
  const items = Array.isArray(payload.items) ? payload.items : []
  return items.filter((item): item is Record<string, unknown> => item !== null && typeof item === 'object')
}

const phaseIsTerminal = (phase: string | null) => (phase ? TERMINAL_PHASES.has(phase.toLowerCase()) : false)

const runIdFromResource = (resource: Record<string, unknown>) => {
  const parameters = asRecord(readNested(resource, ['spec', 'parameters'])) ?? {}
  return asString(parameters.runId) ?? asString(parameters.run_id)
}

const resourceMetadata = (resource: Record<string, unknown>) => asRecord(resource.metadata) ?? {}

const resourceAnnotations = (resource: Record<string, unknown>) =>
  asRecord(resourceMetadata(resource).annotations) ?? {}

const eventIdFor = (ref: TerminalEventRef) => `${ref.namespace}/${ref.name}/${ref.uid}/${ref.phase}`

const observedAtFor = (resource: Record<string, unknown>) =>
  asString(readNested(resource, ['status', 'finishedAt'])) ??
  asString(readNested(resource, ['status', 'updatedAt'])) ??
  asString(readNested(resource, ['status', 'startedAt'])) ??
  asString(readNested(resource, ['metadata', 'creationTimestamp']))

const normalizeAnnotationNamePart = (value: string, fallback: string) => {
  const normalized = value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_.-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 24)
  return normalized || fallback
}

const ackAnnotationBase = (consumer: string, phase: string) =>
  `${ACK_ANNOTATION_PREFIX}.${normalizeAnnotationNamePart(consumer, 'consumer')}.${normalizeAnnotationNamePart(
    phase,
    'phase',
  )}`

const ackAnnotationKeys = (consumer: string, phase: string) => {
  const base = ackAnnotationBase(consumer, phase)
  return {
    at: `${base}.at`,
    outcome: `${base}.outcome`,
    message: `${base}.message`,
    receipt: `${base}.receipt`,
  }
}

const ackState = (resource: Record<string, unknown>, consumer: string | null, phase: string) => {
  if (!consumer) {
    return { acked: false, ackedAt: null, ackOutcome: null }
  }
  const annotations = resourceAnnotations(resource)
  const keys = ackAnnotationKeys(consumer, phase)
  return {
    acked: asString(annotations[keys.at]) !== null,
    ackedAt: asString(annotations[keys.at]),
    ackOutcome: asString(annotations[keys.outcome]),
  }
}

const toTerminalEvent = (
  resource: Record<string, unknown>,
  consumer: string | null,
): AgentsAgentRunTerminalEvent | null => {
  const metadata = resourceMetadata(resource)
  const status = asRecord(resource.status) ?? {}
  const namespace = asString(metadata.namespace) ?? DEFAULT_NAMESPACE
  const name = asString(metadata.name)
  const uid = asString(metadata.uid) ?? name
  const phase = asString(status.phase)
  if (!name || !uid || !phase) return null
  if (!phaseIsTerminal(phase)) return null
  const ack = ackState(resource, consumer, phase)
  return {
    eventId: eventIdFor({ namespace, name, uid, phase }),
    name,
    namespace,
    uid,
    phase,
    runId: runIdFromResource(resource),
    observedAt: observedAtFor(resource),
    acked: ack.acked,
    ackedAt: ack.ackedAt,
    ackOutcome: ack.ackOutcome,
    resource,
    status,
  }
}

const parseListRequest = (
  request: Request,
): Effect.Effect<AgentRunTerminalEventsRequest, AgentRunTerminalEventInvalidRequestError> =>
  Effect.sync(() => {
    const url = new URL(request.url)
    return {
      namespace: normalizeNamespace(url.searchParams.get('namespace'), DEFAULT_NAMESPACE),
      runIdPrefix: asString(url.searchParams.get('runIdPrefix')) ?? asString(url.searchParams.get('run_id_prefix')),
      consumer: asString(url.searchParams.get('consumer')),
      includeAcked: parseBoolean(url.searchParams.get('includeAcked'), false),
      limit: parseLimit(url.searchParams.get('limit')),
    }
  })

const parseTerminalEventRef = (
  eventId: string,
): Effect.Effect<TerminalEventRef, AgentRunTerminalEventInvalidRequestError> =>
  Effect.gen(function* () {
    const parts = eventId.split('/')
    if (parts.length !== 4 || parts.some((part) => part.trim().length === 0)) {
      return yield* Effect.fail(
        new AgentRunTerminalEventInvalidRequestError({ message: 'eventId must be namespace/name/uid/phase' }),
      )
    }
    return {
      namespace: parts[0]!,
      name: parts[1]!,
      uid: parts[2]!,
      phase: parts[3]!,
    }
  })

const parseAckRequest = (
  request: Request,
): Effect.Effect<AgentsAgentRunTerminalEventAckInput, AgentRunTerminalEventInvalidRequestError> =>
  Effect.tryPromise({
    try: async () => {
      const payload = await parseJsonBody(request)
      const eventId = asString(payload.eventId)
      const consumer = asString(payload.consumer)
      if (!eventId) throw new Error('eventId is required')
      if (!consumer) throw new Error('consumer is required')
      return {
        eventId,
        consumer,
        outcome: asString(payload.outcome),
        message: asString(payload.message),
        receiptRef: asString(payload.receiptRef),
        annotations: parseAckAnnotations(payload.annotations),
      }
    },
    catch: (cause) =>
      new AgentRunTerminalEventInvalidRequestError({
        message: cause instanceof Error ? cause.message : 'invalid JSON body',
      }),
  })

const parseAckAnnotations = (value: unknown): Record<string, string | null> | null => {
  if (value === undefined || value === null) return null
  const record = asRecord(value)
  if (!record) {
    throw new Error('annotations must be an object when provided')
  }
  const annotations: Record<string, string | null> = {}
  for (const [key, entry] of Object.entries(record)) {
    if (!key.trim()) throw new Error('annotation keys must be non-empty')
    if (entry === null) {
      annotations[key] = null
      continue
    }
    const stringValue = asString(entry)
    if (stringValue === null) {
      throw new Error(`annotation ${key} must be a string or null`)
    }
    annotations[key] = stringValue
  }
  return annotations
}

const getKubeClient = (deps: AgentRunTerminalEventDeps) =>
  Effect.try({
    try: () => deps.kubeClient ?? deps.kubeClientFactory?.() ?? createKubernetesClient(),
    catch: (cause) =>
      new AgentRunTerminalEventKubeError({
        operation: 'create-client',
        namespace: 'unknown',
        cause,
      }),
  })

export const makeAgentRunTerminalEventKubeLayer = (deps: AgentRunTerminalEventDeps = {}) =>
  Layer.effect(
    AgentRunTerminalEventKubeService,
    getKubeClient(deps).pipe(
      Effect.map((kube) => ({
        listAgentRuns: (namespace) =>
          Effect.tryPromise({
            try: async () => asArrayItems(await kube.list(RESOURCE_MAP.AgentRun, namespace)),
            catch: (cause) => new AgentRunTerminalEventKubeError({ operation: 'list', namespace, cause }),
          }),
        getAgentRun: (namespace, name) =>
          Effect.tryPromise({
            try: () => kube.get(RESOURCE_MAP.AgentRun, name, namespace),
            catch: (cause) => new AgentRunTerminalEventKubeError({ operation: 'get', namespace, name, cause }),
          }),
        patchAgentRunAnnotations: (namespace, name, annotations) =>
          Effect.tryPromise({
            try: () =>
              kube.patch(RESOURCE_MAP.AgentRun, name, namespace, {
                metadata: { annotations },
              }),
            catch: (cause) => new AgentRunTerminalEventKubeError({ operation: 'patch', namespace, name, cause }),
          }),
      })),
    ),
  )

export const listAgentRunTerminalEventsEffect = (
  request: Request,
): Effect.Effect<
  AgentsAgentRunTerminalEventsListResult,
  AgentRunTerminalEventError,
  AgentRunTerminalEventKubeService
> =>
  Effect.gen(function* () {
    const parsed = yield* parseListRequest(request)
    const kube = yield* AgentRunTerminalEventKubeService
    const resources = yield* kube.listAgentRuns(parsed.namespace)
    const events = resources
      .map((resource) => toTerminalEvent(resource, parsed.consumer))
      .filter((event): event is AgentsAgentRunTerminalEvent => event !== null)
      .filter((event) => (parsed.runIdPrefix ? event.runId?.startsWith(parsed.runIdPrefix) : true))
      .filter((event) => (parsed.consumer && !parsed.includeAcked ? !event.acked : true))
      .sort((left, right) => {
        if (!left.observedAt && !right.observedAt) return 0
        if (!left.observedAt) return 1
        if (!right.observedAt) return -1
        return right.observedAt.localeCompare(left.observedAt)
      })

    return {
      ok: true,
      namespace: parsed.namespace,
      consumer: parsed.consumer,
      total: events.length,
      events: events.slice(0, parsed.limit),
    }
  })

export const ackAgentRunTerminalEventEffect = (
  request: Request,
): Effect.Effect<AgentsAgentRunTerminalEventAckResult, AgentRunTerminalEventError, AgentRunTerminalEventKubeService> =>
  Effect.gen(function* () {
    const payload = yield* parseAckRequest(request)
    const ref = yield* parseTerminalEventRef(payload.eventId)
    const kube = yield* AgentRunTerminalEventKubeService
    const resource = yield* kube.getAgentRun(ref.namespace, ref.name)
    if (!resource) {
      return yield* Effect.fail(new AgentRunTerminalEventNotFoundError({ eventId: payload.eventId }))
    }
    const metadata = resourceMetadata(resource)
    const uid = asString(metadata.uid)
    if (uid && uid !== ref.uid) {
      return yield* Effect.fail(
        new AgentRunTerminalEventConflictError({
          eventId: payload.eventId,
          message: 'terminal AgentRun event uid is stale',
        }),
      )
    }
    const phase = asString(readNested(resource, ['status', 'phase']))
    if (phase !== ref.phase) {
      return yield* Effect.fail(
        new AgentRunTerminalEventConflictError({
          eventId: payload.eventId,
          message: 'terminal AgentRun event phase is stale',
        }),
      )
    }
    if (!phaseIsTerminal(phase)) {
      return yield* Effect.fail(
        new AgentRunTerminalEventConflictError({
          eventId: payload.eventId,
          message: 'AgentRun is not in a terminal phase',
        }),
      )
    }

    const keys = ackAnnotationKeys(payload.consumer, ref.phase)
    const annotations: Record<string, string | null> = {
      [keys.at]: new Date().toISOString(),
      [keys.outcome]: payload.outcome?.trim() || 'acked',
      [keys.message]: payload.message?.trim() || null,
      [keys.receipt]: payload.receiptRef?.trim() || null,
      ...(payload.annotations ?? {}),
    }
    const patched = yield* kube.patchAgentRunAnnotations(ref.namespace, ref.name, annotations)
    return {
      ok: true,
      eventId: payload.eventId,
      name: ref.name,
      namespace: ref.namespace,
      consumer: payload.consumer,
      resource: patched,
    }
  })

const errorStatus = (error: AgentRunTerminalEventError) => {
  if (error instanceof AgentRunTerminalEventInvalidRequestError) return 400
  if (error instanceof AgentRunTerminalEventNotFoundError) return 404
  if (error instanceof AgentRunTerminalEventConflictError) return 409
  return 502
}

const errorMessage = (error: AgentRunTerminalEventError) => {
  if (error instanceof AgentRunTerminalEventInvalidRequestError) return error.message
  if (error instanceof AgentRunTerminalEventNotFoundError) return 'terminal AgentRun event not found'
  if (error instanceof AgentRunTerminalEventConflictError) return error.message
  const cause = error.cause instanceof Error ? error.cause.message : String(error.cause)
  return `kubernetes ${error.operation} failed for AgentRun ${error.namespace}/${error.name ?? '*'}: ${cause}`
}

const errorDetails = (error: AgentRunTerminalEventError) => {
  if (error instanceof AgentRunTerminalEventKubeError) {
    return { operation: error.operation, namespace: error.namespace, ...(error.name ? { name: error.name } : {}) }
  }
  if (error instanceof AgentRunTerminalEventNotFoundError) {
    return { eventId: error.eventId }
  }
  if (error instanceof AgentRunTerminalEventConflictError) {
    return { eventId: error.eventId }
  }
  return undefined
}

const runTerminalEventEffect = async <A>(
  effect: Effect.Effect<A, AgentRunTerminalEventError, AgentRunTerminalEventKubeService>,
  deps: AgentRunTerminalEventDeps,
) => Effect.runPromise(effect.pipe(Effect.provide(makeAgentRunTerminalEventKubeLayer(deps)), Effect.either))

export const listAgentRunTerminalEvents = async (request: Request, deps: AgentRunTerminalEventDeps = {}) => {
  const result = await runTerminalEventEffect(listAgentRunTerminalEventsEffect(request), deps)
  if (result._tag === 'Right') return okResponse(result.right)
  return errorResponse(errorMessage(result.left), errorStatus(result.left), errorDetails(result.left))
}

export const ackAgentRunTerminalEvent = async (request: Request, deps: AgentRunTerminalEventDeps = {}) => {
  const result = await runTerminalEventEffect(ackAgentRunTerminalEventEffect(request), deps)
  if (result._tag === 'Right') return okResponse(result.right)
  return errorResponse(errorMessage(result.left), errorStatus(result.left), errorDetails(result.left))
}

export const __test__ = {
  ackAnnotationKeys,
  eventIdFor,
  parseAckAnnotations,
  toTerminalEvent,
}
