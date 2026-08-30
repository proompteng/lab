import { Context, Data, Effect, Layer } from 'effect'

import { buildDeliveryIdLabels } from '../agent-resource-labels'
import { resolvePrimitiveKind, type ControlPlaneResourceKind } from '../control-plane-primitive-kinds'
import { errorResponse, okResponse, parseJsonBody, requireIdempotencyKey } from '../http'
import { createKubernetesClient, type KubernetesClient } from '../kube-types'
import { asRecord, asString, normalizeNamespace } from '../primitives'

export class TypedResourceInvalidRequestError extends Data.TaggedError('TypedResourceInvalidRequestError')<{
  readonly message: string
}> {}

export class TypedResourceKindMismatchError extends Data.TaggedError('TypedResourceKindMismatchError')<{
  readonly expectedKind: string
  readonly actualKind: string
}> {}

export class TypedResourceNotFoundError extends Data.TaggedError('TypedResourceNotFoundError')<{
  readonly kind: string
  readonly name: string
  readonly namespace: string
}> {}

export class TypedResourceKubeError extends Data.TaggedError('TypedResourceKubeError')<{
  readonly operation: 'list' | 'get' | 'patch' | 'apply'
  readonly kind: string
  readonly namespace: string
  readonly name?: string
  readonly cause: unknown
}> {}

type TypedResourceError =
  | TypedResourceInvalidRequestError
  | TypedResourceKindMismatchError
  | TypedResourceNotFoundError
  | TypedResourceKubeError

type TypedResourceKubernetesServiceShape = {
  readonly client: KubernetesClient
}

export class TypedResourceKubernetesService extends Context.Tag('agents/TypedResourceKubernetesService')<
  TypedResourceKubernetesService,
  TypedResourceKubernetesServiceShape
>() {}

export type TypedResourceDeps = {
  kubeClient?: KubernetesClient
}

export type TypedResourceApiDependencies = TypedResourceDeps

export const makeTypedResourceLayer = (deps: TypedResourceDeps = {}) =>
  Layer.succeed(TypedResourceKubernetesService, { client: deps.kubeClient ?? createKubernetesClient() })

const parseLimit = (value: string | null) => {
  if (!value) return null
  const parsed = Number(value)
  if (!Number.isFinite(parsed) || parsed <= 0) return null
  return Math.min(Math.floor(parsed), 500)
}

const parseFilter = (value: string | null) => {
  if (!value) return null
  const trimmed = value.trim()
  return trimmed.length > 0 ? trimmed : null
}

const resourceKindMatches = (actual: string, expected: string) =>
  actual.trim().replace(/\s+/g, '').toLowerCase() === expected.trim().replace(/\s+/g, '').toLowerCase()

const resolveTypedKind = (kind: ControlPlaneResourceKind) =>
  Effect.sync(() => resolvePrimitiveKind(kind)).pipe(
    Effect.flatMap((resolved) =>
      resolved
        ? Effect.succeed(resolved)
        : Effect.fail(new TypedResourceInvalidRequestError({ message: `unsupported resource kind ${kind}` })),
    ),
  )

const normalizeMetadataPatchMap = (value: unknown, fieldName: string) => {
  if (value === undefined || value === null) return null
  const record = asRecord(value)
  if (!record) {
    throw new Error(`${fieldName} must be an object`)
  }

  const result: Record<string, string | null> = {}
  for (const [rawKey, rawValue] of Object.entries(record)) {
    const key = rawKey.trim()
    if (!key) {
      throw new Error(`${fieldName} keys must be non-empty strings`)
    }
    if (rawValue === null) {
      result[key] = null
      continue
    }
    if (typeof rawValue !== 'string') {
      throw new Error(`${fieldName}.${key} must be a string or null`)
    }
    result[key] = rawValue
  }

  return Object.keys(result).length > 0 ? result : null
}

const parseMetadataPatchPayload = (payload: Record<string, unknown>) => {
  const metadata = asRecord(payload.metadata) ?? {}
  const annotations = normalizeMetadataPatchMap(metadata.annotations ?? payload.annotations, 'metadata.annotations')
  const labels = normalizeMetadataPatchMap(metadata.labels ?? payload.labels, 'metadata.labels')

  if (!annotations && !labels) {
    throw new Error('metadata.annotations or metadata.labels is required')
  }

  return {
    metadata: {
      ...(annotations ? { annotations } : {}),
      ...(labels ? { labels } : {}),
    },
  }
}

const toSummary = (resource: Record<string, unknown>) => ({
  apiVersion: asString(resource.apiVersion) ?? null,
  kind: asString(resource.kind) ?? null,
  metadata: asRecord(resource.metadata) ?? {},
  spec: asRecord(resource.spec) ?? {},
  status: asRecord(resource.status) ?? {},
})

const matchesAgentRunFilters = (resource: Record<string, unknown>, phase?: string | null, runtime?: string | null) => {
  if (phase) {
    const status = asRecord(resource.status) ?? {}
    const itemPhase = asString(status.phase)
    if (itemPhase !== phase) return false
  }
  if (runtime) {
    const spec = asRecord(resource.spec) ?? {}
    const runtimeSpec = asRecord(spec.runtime) ?? {}
    const runtimeType = asString(runtimeSpec.type)
    if (runtimeType !== runtime) return false
  }
  return true
}

const kubeEffect = <A>(
  operation: TypedResourceKubeError['operation'],
  kind: string,
  namespace: string,
  run: (client: KubernetesClient) => Promise<A>,
  name?: string,
): Effect.Effect<A, TypedResourceKubeError, TypedResourceKubernetesService> =>
  Effect.gen(function* () {
    const { client } = yield* TypedResourceKubernetesService
    return yield* Effect.tryPromise({
      try: () => run(client),
      catch: (cause) => new TypedResourceKubeError({ operation, kind, namespace, name, cause }),
    })
  })

const parseJsonBodyEffect = (
  request: Request,
): Effect.Effect<Record<string, unknown>, TypedResourceInvalidRequestError> =>
  Effect.tryPromise({
    try: () => parseJsonBody(request),
    catch: (cause) =>
      new TypedResourceInvalidRequestError({
        message: cause instanceof Error ? cause.message : 'invalid JSON body',
      }),
  })

const requireIdempotencyKeyEffect = (request: Request) =>
  Effect.try({
    try: () => requireIdempotencyKey(request),
    catch: (cause) =>
      new TypedResourceInvalidRequestError({
        message: cause instanceof Error ? cause.message : 'Idempotency-Key header is required',
      }),
  })

const metadataNamespace = (payload: Record<string, unknown>) => {
  const metadata = asRecord(payload.metadata)
  if (!metadata) {
    throw new TypedResourceInvalidRequestError({ message: 'metadata is required' })
  }
  return normalizeNamespace(asString(metadata.namespace), 'agents')
}

const normalizeTypedResourcePayload = (expectedKind: string, payload: Record<string, unknown>, deliveryId: string) => {
  const metadataInput = asRecord(payload.metadata)
  if (!metadataInput) {
    throw new TypedResourceInvalidRequestError({ message: 'metadata is required' })
  }
  const rawKind = asString(payload.kind)
  if (rawKind && !resourceKindMatches(rawKind, expectedKind)) {
    throw new TypedResourceKindMismatchError({ expectedKind, actualKind: rawKind })
  }

  const namespace = normalizeNamespace(asString(metadataInput.namespace), 'agents')
  const labels = {
    ...(asRecord(metadataInput.labels) ?? {}),
    ...buildDeliveryIdLabels(deliveryId),
  }

  return {
    kind: expectedKind,
    namespace,
    resource: {
      ...payload,
      ...(asString(payload.apiVersion) ? { apiVersion: asString(payload.apiVersion) } : {}),
      kind: expectedKind,
      metadata: {
        ...metadataInput,
        namespace,
        labels,
      },
    },
  }
}

const describeTypedResourceError = (error: TypedResourceError) => {
  switch (error._tag) {
    case 'TypedResourceInvalidRequestError':
      return { message: error.message, status: 400 }
    case 'TypedResourceKindMismatchError':
      return { message: `kind must be ${error.expectedKind}`, status: 400 }
    case 'TypedResourceNotFoundError':
      return { message: `${error.kind} not found`, status: 404 }
    case 'TypedResourceKubeError':
      return {
        message: error.cause instanceof Error ? error.cause.message : String(error.cause),
        status: 500,
        details: { kind: error.kind, namespace: error.namespace, ...(error.name ? { name: error.name } : {}) },
      }
  }
}

const runTypedResourceEffect = async <A>(
  effect: Effect.Effect<A, TypedResourceError, TypedResourceKubernetesService>,
  deps: TypedResourceDeps,
) => Effect.runPromise(effect.pipe(Effect.provide(makeTypedResourceLayer(deps)), Effect.either))

export const listTypedResourceEffect = (
  kind: ControlPlaneResourceKind,
  request: Request,
): Effect.Effect<Record<string, unknown>, TypedResourceError, TypedResourceKubernetesService> =>
  Effect.gen(function* () {
    const resolved = yield* resolveTypedKind(kind)
    const url = new URL(request.url)
    const namespace = normalizeNamespace(url.searchParams.get('namespace'), 'agents')
    const limit = parseLimit(url.searchParams.get('limit'))
    const labelSelector =
      parseFilter(url.searchParams.get('labelSelector')) ?? parseFilter(url.searchParams.get('label_selector'))
    const phase = parseFilter(url.searchParams.get('phase'))
    const runtime = parseFilter(url.searchParams.get('runtime'))
    const list = yield* kubeEffect('list', resolved.kind, namespace, (client) =>
      client.list(resolved.resource, namespace, labelSelector ?? undefined),
    )
    const itemsRaw = Array.isArray((list as Record<string, unknown>).items)
      ? ((list as { items: unknown[] }).items as unknown[])
      : []
    const summaries = itemsRaw.map((item) => toSummary(asRecord(item) ?? {}))
    const filtered =
      resolved.kind === 'AgentRun' && (phase || runtime)
        ? summaries.filter((item) => matchesAgentRunFilters(item, phase, runtime))
        : summaries
    const sliced = limit ? filtered.slice(0, limit) : filtered
    return {
      ok: true,
      kind: resolved.kind,
      namespace,
      total: filtered.length,
      items: sliced,
    }
  })

export const getTypedResourceEffect = (
  kind: ControlPlaneResourceKind,
  request: Request,
): Effect.Effect<Record<string, unknown>, TypedResourceError, TypedResourceKubernetesService> =>
  Effect.gen(function* () {
    const resolved = yield* resolveTypedKind(kind)
    const url = new URL(request.url)
    const name = asString(url.searchParams.get('name'))
    if (!name) {
      return yield* Effect.fail(new TypedResourceInvalidRequestError({ message: 'name is required' }))
    }
    const namespace = normalizeNamespace(url.searchParams.get('namespace'), 'agents')
    const resource = yield* kubeEffect(
      'get',
      resolved.kind,
      namespace,
      (client) => client.get(resolved.resource, name, namespace),
      name,
    )
    if (!resource) {
      return yield* Effect.fail(new TypedResourceNotFoundError({ kind: resolved.kind, name, namespace }))
    }
    return {
      ok: true,
      kind: resolved.kind,
      namespace,
      resource,
    }
  })

export const patchTypedResourceMetadataEffect = (
  kind: ControlPlaneResourceKind,
  request: Request,
): Effect.Effect<Record<string, unknown>, TypedResourceError, TypedResourceKubernetesService> =>
  Effect.gen(function* () {
    const resolved = yield* resolveTypedKind(kind)
    const url = new URL(request.url)
    const name = asString(url.searchParams.get('name'))
    if (!name) {
      return yield* Effect.fail(new TypedResourceInvalidRequestError({ message: 'name is required' }))
    }
    const namespace = normalizeNamespace(url.searchParams.get('namespace'), 'agents')
    const payload = yield* parseJsonBodyEffect(request)
    const patch = yield* Effect.try({
      try: () => parseMetadataPatchPayload(payload),
      catch: (cause) =>
        new TypedResourceInvalidRequestError({
          message: cause instanceof Error ? cause.message : 'metadata.annotations or metadata.labels is required',
        }),
    })
    const resource = yield* kubeEffect(
      'patch',
      resolved.kind,
      namespace,
      (client) => client.patch(resolved.resource, name, namespace, patch),
      name,
    )
    return {
      ok: true,
      kind: resolved.kind,
      namespace,
      resource,
    }
  })

export const postTypedResourceEffect = (
  kind: ControlPlaneResourceKind,
  request: Request,
): Effect.Effect<Record<string, unknown>, TypedResourceError, TypedResourceKubernetesService> =>
  Effect.gen(function* () {
    const resolved = yield* resolveTypedKind(kind)
    const deliveryId = yield* requireIdempotencyKeyEffect(request)
    const payload = yield* parseJsonBodyEffect(request)
    const namespace = yield* Effect.try({
      try: () => metadataNamespace(payload),
      catch: (cause) =>
        cause instanceof TypedResourceInvalidRequestError
          ? cause
          : new TypedResourceInvalidRequestError({ message: 'metadata is required' }),
    })
    const parsed = yield* Effect.try({
      try: () => normalizeTypedResourcePayload(resolved.kind, payload, deliveryId),
      catch: (cause) =>
        cause instanceof TypedResourceKindMismatchError || cause instanceof TypedResourceInvalidRequestError
          ? cause
          : new TypedResourceInvalidRequestError({ message: 'invalid resource payload' }),
    })
    const applied = yield* kubeEffect('apply', resolved.kind, namespace, (client) => client.apply(parsed.resource))
    return {
      ok: true,
      kind: parsed.kind,
      namespace: parsed.namespace,
      resource: applied,
    }
  })

export const typedResourceResponse = async (
  effect: Effect.Effect<Record<string, unknown>, TypedResourceError, TypedResourceKubernetesService>,
  deps: TypedResourceDeps,
  successStatus = 200,
) => {
  const result = await runTypedResourceEffect(effect, deps)
  if (result._tag === 'Right') {
    return okResponse(result.right, successStatus)
  }
  const error = describeTypedResourceError(result.left)
  return errorResponse(error.message, error.status, 'details' in error ? error.details : undefined)
}

export const listTypedResourceHandler = (
  kind: ControlPlaneResourceKind,
  request: Request,
  deps: TypedResourceApiDependencies = {},
) => typedResourceResponse(listTypedResourceEffect(kind, request), deps)

export const getTypedResourceHandler = (
  kind: ControlPlaneResourceKind,
  request: Request,
  deps: TypedResourceApiDependencies = {},
) => typedResourceResponse(getTypedResourceEffect(kind, request), deps)

export const postTypedResourceHandler = (
  kind: ControlPlaneResourceKind,
  request: Request,
  deps: TypedResourceApiDependencies = {},
) => typedResourceResponse(postTypedResourceEffect(kind, request), deps, 201)

export const patchTypedResourceMetadataHandler = (
  kind: ControlPlaneResourceKind,
  request: Request,
  deps: TypedResourceApiDependencies = {},
) => typedResourceResponse(patchTypedResourceMetadataEffect(kind, request), deps)
