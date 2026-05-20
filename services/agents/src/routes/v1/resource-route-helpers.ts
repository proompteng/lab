import {
  getPrimitiveResource,
  patchPrimitiveResourceMetadata,
  postPrimitiveResource,
} from '../api/agents/control-plane/resource'
import { listPrimitiveResources } from '../api/agents/control-plane/resources'
import { errorResponse } from '../../server/http'
import { asRecord, asString } from '../../server/primitives'

const toKindResourceUrl = (request: Request, kind: string, path: string) => {
  const incoming = new URL(request.url)
  const target = new URL(path, incoming.origin)
  for (const [key, value] of incoming.searchParams) {
    if (key !== 'kind') target.searchParams.append(key, value)
  }
  target.searchParams.set('kind', kind)
  return target
}

const copyRequestWithKind = async (request: Request, kind: string, path: string, method: string) => {
  const body = method === 'GET' ? undefined : await request.text()
  return new Request(toKindResourceUrl(request, kind, path), {
    ...(body !== undefined ? { body } : {}),
    headers: request.headers,
    method,
  })
}

const parseRequestJsonBody = async (request: Request) => {
  try {
    const payload = (await request.json()) as unknown
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
      throw new Error('invalid JSON body')
    }
    return payload as Record<string, unknown>
  } catch (error) {
    throw new Error(error instanceof Error ? error.message : 'invalid JSON body')
  }
}

const copyHeaders = (headers: Headers) => {
  const copied = new Headers(headers)
  if (!copied.has('content-type')) {
    copied.set('content-type', 'application/json')
  }
  return copied
}

const resourceKindMatches = (actual: string, expected: string) =>
  actual.trim().replace(/\s+/g, '').toLowerCase() === expected.trim().replace(/\s+/g, '').toLowerCase()

const requestWithFixedKindBody = async (request: Request, kind: string, path: string) => {
  const payload = await parseRequestJsonBody(request)
  const metadata = asRecord(payload.metadata)
  const rawKind = asString(payload.kind)
  if (metadata && rawKind && !resourceKindMatches(rawKind, kind)) {
    return {
      ok: false as const,
      response: errorResponse(`kind must be ${kind}`, 400),
    }
  }

  return {
    ok: true as const,
    request: new Request(toKindResourceUrl(request, kind, path), {
      body: JSON.stringify({ ...payload, ...(metadata ? { kind } : {}) }),
      headers: copyHeaders(request.headers),
      method: 'POST',
    }),
  }
}

export const listFixedKindResources = (
  kind: string,
  request: Request,
  deps: Parameters<typeof listPrimitiveResources>[1] = {},
) =>
  listPrimitiveResources(
    new Request(toKindResourceUrl(request, kind, '/api/agents/control-plane/resources'), {
      headers: request.headers,
    }),
    deps,
  )

export const getFixedKindResource = async (
  kind: string,
  request: Request,
  deps: Parameters<typeof getPrimitiveResource>[1] = {},
) => getPrimitiveResource(await copyRequestWithKind(request, kind, '/api/agents/control-plane/resource', 'GET'), deps)

export const postFixedKindResource = async (
  kind: string,
  request: Request,
  deps: Parameters<typeof postPrimitiveResource>[1] = {},
) => {
  const forwarded = await requestWithFixedKindBody(request, kind, '/api/agents/control-plane/resource')
  if (!forwarded.ok) return forwarded.response
  return postPrimitiveResource(forwarded.request, deps)
}

export const patchFixedKindResourceMetadata = async (
  kind: string,
  request: Request,
  deps: Parameters<typeof patchPrimitiveResourceMetadata>[1] = {},
) =>
  patchPrimitiveResourceMetadata(
    await copyRequestWithKind(request, kind, '/api/agents/control-plane/resource', 'PATCH'),
    deps,
  )
