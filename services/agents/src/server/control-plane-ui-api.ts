import {
  controlPlanePrimitiveRegistry,
  type ControlPlanePrimitiveRegistryEntry,
} from '../control-plane/primitive-registry.generated'
import { type ControlPlaneResourceKind } from './control-plane-primitive-kinds'
import { errorResponse, okResponse } from './http'
import { asRecord } from './primitives'
import {
  getTypedResourceHandler,
  listTypedResourceHandler,
  postTypedResourceHandler,
  type TypedResourceApiDependencies,
} from './v1/typed-resources'

const registryByKind = new Map(
  controlPlanePrimitiveRegistry.flatMap((entry) => [
    [entry.kind.toLowerCase(), entry],
    [entry.display.pathSegment.toLowerCase(), entry],
    [entry.plural.toLowerCase(), entry],
  ]),
)

export const listControlPlanePrimitiveDefinitions = () =>
  okResponse({
    ok: true,
    total: controlPlanePrimitiveRegistry.length,
    items: controlPlanePrimitiveRegistry,
  })

export const resolveControlPlanePrimitiveDefinition = (
  rawKind: string | null | undefined,
): ControlPlanePrimitiveRegistryEntry | null => {
  const normalized = rawKind?.trim().toLowerCase()
  if (!normalized) return null
  return registryByKind.get(normalized) ?? null
}

const cloneRequestWithJsonBody = (request: Request, body: unknown) => {
  const headers = new Headers(request.headers)
  headers.set('content-type', 'application/json')
  headers.delete('content-length')
  return new Request(request.url, {
    method: request.method,
    headers,
    body: JSON.stringify(body),
  })
}

const sanitizeAgentRunCreatePayload = async (entry: ControlPlanePrimitiveRegistryEntry, request: Request) => {
  if (entry.kind !== 'AgentRun') return request

  const payload = (await request.json()) as unknown
  const root = asRecord(payload)
  const spec = asRecord(root?.spec)
  const parameters = asRecord(spec?.parameters)
  if (!root || !spec || !asRecord(spec.implementationSpecRef) || !parameters || !('prompt' in parameters)) {
    return cloneRequestWithJsonBody(request, payload)
  }

  const nextParameters = { ...parameters }
  delete nextParameters.prompt
  const nextSpec = {
    ...spec,
    ...(Object.keys(nextParameters).length > 0 ? { parameters: nextParameters } : { parameters: undefined }),
  }
  if (nextSpec.parameters === undefined) delete nextSpec.parameters

  return cloneRequestWithJsonBody(request, {
    ...root,
    spec: nextSpec,
  })
}

const resolveKindOrError = (rawKind: string | null | undefined) => {
  const entry = resolveControlPlanePrimitiveDefinition(rawKind)
  if (!entry) {
    return { ok: false as const, response: errorResponse(`unsupported primitive kind ${rawKind ?? ''}`, 404) }
  }
  return { ok: true as const, entry }
}

export const listPrimitiveResourcesForUi = (
  rawKind: string | null | undefined,
  request: Request,
  deps: TypedResourceApiDependencies = {},
) => {
  const resolved = resolveKindOrError(rawKind)
  if (!resolved.ok) return resolved.response
  return listTypedResourceHandler(resolved.entry.kind as ControlPlaneResourceKind, request, deps)
}

export const getPrimitiveResourceForUi = (
  rawKind: string | null | undefined,
  request: Request,
  deps: TypedResourceApiDependencies = {},
) => {
  const resolved = resolveKindOrError(rawKind)
  if (!resolved.ok) return resolved.response
  return getTypedResourceHandler(resolved.entry.kind as ControlPlaneResourceKind, request, deps)
}

export const createPrimitiveResourceForUi = async (
  rawKind: string | null | undefined,
  request: Request,
  deps: TypedResourceApiDependencies = {},
) => {
  const resolved = resolveKindOrError(rawKind)
  if (!resolved.ok) return resolved.response
  const sanitizedRequest = await sanitizeAgentRunCreatePayload(resolved.entry, request)
  return postTypedResourceHandler(resolved.entry.kind as ControlPlaneResourceKind, sanitizedRequest, deps)
}
