import { Context, Data, Effect, Layer } from 'effect'

import { resolvePrimitiveKind } from '../control-plane-primitive-kinds'
import { errorResponse, okResponse } from '../http'
import { createKubernetesClient, type KubernetesClient } from '../kube-types'
import { asString, normalizeNamespace } from '../primitives'

type PrimitiveEventsRequest = {
  kind: string
  name: string
  namespace: string
  uid: string | null
  limit: number
}

export type PrimitiveEventsDependencies = {
  kubeClient?: KubernetesClient
  kubeClientFactory?: () => KubernetesClient
}

type PrimitiveEventsKubeOperation = 'create-client' | 'list-events'

export class PrimitiveEventsInvalidRequestError extends Data.TaggedError('PrimitiveEventsInvalidRequestError')<{
  readonly message: string
}> {}

export class PrimitiveEventsKubeError extends Data.TaggedError('PrimitiveEventsKubeError')<{
  readonly operation: PrimitiveEventsKubeOperation
  readonly namespace: string
  readonly kind: string
  readonly name: string
  readonly cause: unknown
}> {}

type PrimitiveEventsError = PrimitiveEventsInvalidRequestError | PrimitiveEventsKubeError

type PrimitiveEventsKubeServiceDefinition = {
  readonly listEvents: (input: {
    namespace: string
    fieldSelector: string
    kind: string
    name: string
  }) => Effect.Effect<Record<string, unknown>[], PrimitiveEventsKubeError>
}

export class PrimitiveEventsKubeService extends Context.Tag('agents/PrimitiveEventsKubeService')<
  PrimitiveEventsKubeService,
  PrimitiveEventsKubeServiceDefinition
>() {}

const parseLimit = (value: string | null) => {
  if (!value) return 25
  const parsed = Number(value)
  if (!Number.isFinite(parsed) || parsed <= 0) return 25
  return Math.min(Math.floor(parsed), 200)
}

const parseEventTime = (event: Record<string, unknown>) => {
  const eventTime = asString(event.eventTime)
  const lastTimestamp = asString(event.lastTimestamp)
  const firstTimestamp = asString(event.firstTimestamp)
  return eventTime || lastTimestamp || firstTimestamp || null
}

const toEventSummary = (event: Record<string, unknown>) => {
  const metadata =
    event.metadata && typeof event.metadata === 'object' ? (event.metadata as Record<string, unknown>) : {}
  return {
    name: asString(metadata.name) ?? null,
    namespace: asString(metadata.namespace) ?? null,
    type: asString(event.type) ?? null,
    reason: asString(event.reason) ?? null,
    action: asString(event.action) ?? null,
    count: typeof event.count === 'number' ? event.count : null,
    message: asString(event.message) ?? null,
    firstTimestamp: asString(event.firstTimestamp) ?? null,
    lastTimestamp: asString(event.lastTimestamp) ?? null,
    eventTime: asString(event.eventTime) ?? null,
    involvedObject: event.involvedObject ?? null,
  }
}

const buildFieldSelector = (kind: string, name: string, uid?: string | null) => {
  const fields = [`involvedObject.kind=${kind}`, `involvedObject.name=${name}`]
  if (uid) fields.push(`involvedObject.uid=${uid}`)
  return fields.join(',')
}

const getKubeClient = (deps: PrimitiveEventsDependencies) =>
  Effect.try({
    try: () => deps.kubeClient ?? deps.kubeClientFactory?.() ?? createKubernetesClient(),
    catch: (cause) =>
      new PrimitiveEventsKubeError({
        operation: 'create-client',
        namespace: 'unknown',
        kind: 'unknown',
        name: 'unknown',
        cause,
      }),
  })

export const makePrimitiveEventsKubeLayer = (deps: PrimitiveEventsDependencies = {}) =>
  Layer.effect(
    PrimitiveEventsKubeService,
    getKubeClient(deps).pipe(
      Effect.map((kube) => ({
        listEvents: (input) =>
          Effect.tryPromise({
            try: async () => {
              const list = await kube.listEvents(input.namespace, input.fieldSelector)
              const items = Array.isArray(list.items) ? list.items : []
              return items.map((item) => (item && typeof item === 'object' ? (item as Record<string, unknown>) : {}))
            },
            catch: (cause) =>
              new PrimitiveEventsKubeError({
                operation: 'list-events',
                namespace: input.namespace,
                kind: input.kind,
                name: input.name,
                cause,
              }),
          }),
      })),
    ),
  )

const parsePrimitiveEventsRequest = (
  request: Request,
): Effect.Effect<PrimitiveEventsRequest, PrimitiveEventsInvalidRequestError> =>
  Effect.gen(function* () {
    const url = new URL(request.url)
    const kindParam = url.searchParams.get('kind')
    const name = asString(url.searchParams.get('name'))
    const uid = asString(url.searchParams.get('uid'))
    const resolved = resolvePrimitiveKind(kindParam)
    if (!resolved) {
      return yield* Effect.fail(new PrimitiveEventsInvalidRequestError({ message: 'kind is required' }))
    }
    if (!name) {
      return yield* Effect.fail(new PrimitiveEventsInvalidRequestError({ message: 'name is required' }))
    }

    return {
      kind: resolved.kind,
      name,
      uid: uid ?? null,
      namespace: normalizeNamespace(url.searchParams.get('namespace'), 'agents'),
      limit: parseLimit(url.searchParams.get('limit')),
    }
  })

export const listPrimitiveEventsEffect = (
  request: Request,
): Effect.Effect<
  { ok: true; kind: string; namespace: string; name: string; items: ReturnType<typeof toEventSummary>[] },
  PrimitiveEventsError,
  PrimitiveEventsKubeService
> =>
  Effect.gen(function* () {
    const parsed = yield* parsePrimitiveEventsRequest(request)
    const kube = yield* PrimitiveEventsKubeService
    const fieldSelector = buildFieldSelector(parsed.kind, parsed.name, parsed.uid)
    const itemsRaw = yield* kube.listEvents({
      namespace: parsed.namespace,
      fieldSelector,
      kind: parsed.kind,
      name: parsed.name,
    })
    const items = itemsRaw
      .sort((a, b) => {
        const aTime = parseEventTime(a)
        const bTime = parseEventTime(b)
        if (!aTime && !bTime) return 0
        if (!aTime) return 1
        if (!bTime) return -1
        return bTime.localeCompare(aTime)
      })
      .slice(0, parsed.limit)
      .map((event) => toEventSummary(event))

    return { ok: true, kind: parsed.kind, namespace: parsed.namespace, name: parsed.name, items }
  })

const eventErrorStatus = (error: PrimitiveEventsError) => {
  if (error instanceof PrimitiveEventsInvalidRequestError) return 400
  return 500
}

const eventErrorDetails = (error: PrimitiveEventsError) => {
  if (error instanceof PrimitiveEventsKubeError) {
    return {
      kind: error.kind,
      namespace: error.namespace,
      name: error.name,
      operation: error.operation,
    }
  }
  return undefined
}

const eventErrorMessage = (error: PrimitiveEventsError) => {
  if (error instanceof PrimitiveEventsInvalidRequestError) return error.message
  const cause = error.cause instanceof Error ? error.cause.message : String(error.cause)
  return `kubernetes ${error.operation} failed for ${error.kind} ${error.namespace}/${error.name}: ${cause}`
}

export const listPrimitiveEvents = async (request: Request, deps: PrimitiveEventsDependencies = {}) => {
  const result = await Effect.runPromise(
    listPrimitiveEventsEffect(request).pipe(Effect.provide(makePrimitiveEventsKubeLayer(deps)), Effect.either),
  )
  if (result._tag === 'Right') return okResponse(result.right)
  return errorResponse(eventErrorMessage(result.left), eventErrorStatus(result.left), eventErrorDetails(result.left))
}
