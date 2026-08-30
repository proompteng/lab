import {
  KubeConfig,
  ResponseContext,
  SelfDecodingBody,
  ServerConfiguration,
  createConfiguration,
  wrapHttpLibrary,
} from '@kubernetes/client-node'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { extname, join } from 'node:path'
import type { RequestContext } from '@kubernetes/client-node/dist/gen/http/http.js'

type BunKubernetesFetchInit = RequestInit & {
  tls?: {
    rejectUnauthorized: boolean
    ca?: ReturnType<typeof Bun.file>[]
    cert?: ReturnType<typeof Bun.file>
    key?: ReturnType<typeof Bun.file>
  }
}

type ApiClientConstructor<T> = new (configuration: ReturnType<typeof createConfiguration>) => T

const globalState = globalThis as typeof globalThis & {
  __jangarNativeKubeTlsCache?: Map<string, string>
}

const BUN_KUBE_TLS_CACHE_DIR = join(tmpdir(), 'jangar-kube-tls')

export const shouldUseBunKubernetesTransport = (env: Record<string, string | undefined> = process.env) =>
  typeof Bun !== 'undefined' && !env.VITEST && !env.VITEST_POOL_ID && !env.VITEST_WORKER_ID

const getBunTlsCache = () => {
  if (!globalState.__jangarNativeKubeTlsCache) {
    globalState.__jangarNativeKubeTlsCache = new Map<string, string>()
  }

  return globalState.__jangarNativeKubeTlsCache
}

const materializeTlsAsset = (label: string, value: string | Buffer | null | undefined) => {
  if (!value) return null
  if (typeof value === 'string' && existsSync(value)) return value

  const bytes = typeof value === 'string' ? Buffer.from(value) : value
  const digest = createHash('sha256').update(label).update(bytes).digest('hex')
  const path = join(BUN_KUBE_TLS_CACHE_DIR, `${label}-${digest}${extname(label) || '.pem'}`)
  const cache = getBunTlsCache()
  const cached = cache.get(path)
  if (cached) return cached

  mkdirSync(BUN_KUBE_TLS_CACHE_DIR, { recursive: true })
  writeFileSync(path, bytes)
  cache.set(path, path)
  return path
}

const normalizeTlsList = (value: unknown, label: string): string[] => {
  if (Array.isArray(value)) {
    return value.flatMap((entry, index) => normalizeTlsList(entry, `${label}-${index}`))
  }

  if (typeof value === 'string' || Buffer.isBuffer(value)) {
    const path = materializeTlsAsset(label, value)
    return path ? [path] : []
  }

  return []
}

const mergeHeaders = (left: Headers | HeadersInit | undefined, right: Headers | HeadersInit | undefined) => {
  const headers = new Headers(left)
  if (!right) return headers
  new Headers(right).forEach((value, key) => {
    headers.set(key, value)
  })
  return headers
}

const buildBunFetchTlsAssetPaths = (kubeConfig: KubeConfig) => {
  const cluster = kubeConfig.getCurrentCluster()
  const user = kubeConfig.getCurrentUser()

  const caPaths = [
    ...(cluster?.caFile ? [cluster.caFile] : []),
    ...normalizeTlsList(cluster?.caData ? Buffer.from(cluster.caData, 'base64') : null, 'cluster-ca.pem'),
  ]
  const certPath =
    user?.certFile ??
    materializeTlsAsset('client-cert.pem', user?.certData ? Buffer.from(user.certData, 'base64') : null)
  const keyPath =
    user?.keyFile ?? materializeTlsAsset('client-key.pem', user?.keyData ? Buffer.from(user.keyData, 'base64') : null)

  return {
    rejectUnauthorized: !(cluster?.skipTLSVerify ?? false),
    caPaths,
    certPath,
    keyPath,
  }
}

const createBunFetchHttpApi = (kubeConfig: KubeConfig) => {
  const tlsAssetPaths = buildBunFetchTlsAssetPaths(kubeConfig)

  return wrapHttpLibrary({
    send: async (request: RequestContext) => {
      const response = await fetch(request.getUrl(), {
        method: request.getHttpMethod().toString(),
        body: request.getBody() as BodyInit | null | undefined,
        headers: request.getHeaders() as HeadersInit,
        signal: request.getSignal() ?? undefined,
        tls: {
          rejectUnauthorized: tlsAssetPaths.rejectUnauthorized,
          ...(tlsAssetPaths.caPaths.length > 0 ? { ca: tlsAssetPaths.caPaths.map((path) => Bun.file(path)) } : {}),
          ...(tlsAssetPaths.certPath ? { cert: Bun.file(tlsAssetPaths.certPath) } : {}),
          ...(tlsAssetPaths.keyPath ? { key: Bun.file(tlsAssetPaths.keyPath) } : {}),
        },
      })

      const headers: Record<string, string> = {}
      response.headers.forEach((value, name) => {
        headers[name] = value
      })

      return new ResponseContext(
        response.status,
        headers,
        new SelfDecodingBody(response.arrayBuffer().then((body) => Buffer.from(body))),
      )
    },
  })
}

export const buildBunKubernetesFetchInit = async (
  kubeConfig: KubeConfig,
  init: RequestInit = {},
): Promise<BunKubernetesFetchInit> => {
  const headerEntries = (() => {
    if (!init.headers) return undefined
    const entries: Record<string, string> = {}
    new Headers(init.headers).forEach((value, key) => {
      entries[key] = value
    })
    return entries
  })()
  const fetchOptions = await kubeConfig.applyToFetchOptions({
    method: init.method,
    headers: headerEntries,
  })
  const tlsAssetPaths = buildBunFetchTlsAssetPaths(kubeConfig)

  return {
    ...init,
    method: init.method ?? fetchOptions.method ?? 'GET',
    headers: mergeHeaders(fetchOptions.headers as HeadersInit | undefined, init.headers),
    tls: {
      rejectUnauthorized: tlsAssetPaths.rejectUnauthorized,
      ...(tlsAssetPaths.caPaths.length > 0 ? { ca: tlsAssetPaths.caPaths.map((path) => Bun.file(path)) } : {}),
      ...(tlsAssetPaths.certPath ? { cert: Bun.file(tlsAssetPaths.certPath) } : {}),
      ...(tlsAssetPaths.keyPath ? { key: Bun.file(tlsAssetPaths.keyPath) } : {}),
    },
  }
}

export const makeApiClientWithTransport = <T>(kubeConfig: KubeConfig, ApiClientType: ApiClientConstructor<T>) => {
  const cluster = kubeConfig.getCurrentCluster()
  if (!cluster) {
    throw new Error('No active cluster!')
  }

  const configuration = createConfiguration({
    baseServer: new ServerConfiguration(cluster.server, {}),
    authMethods: { default: kubeConfig },
    httpApi: createBunFetchHttpApi(kubeConfig),
  })
  return new ApiClientType(configuration)
}

export const __private = {
  buildBunFetchTlsAssetPaths,
  materializeTlsAsset,
}
