import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { EventEmitter } from 'node:events'

const createTokenReview = vi.fn()
const loadFromCluster = vi.fn()
const makeApiClient = vi.fn(() => ({ createTokenReview }))
const readFileSync = vi.fn()
const httpsRequest = vi.fn()

vi.mock('@kubernetes/client-node', () => {
  class KubeConfig {
    loadFromCluster = loadFromCluster
    makeApiClient = makeApiClient
  }

  class AuthenticationV1Api {}

  return {
    AuthenticationV1Api,
    KubeConfig,
  }
})

vi.mock('node:fs', () => ({
  readFileSync,
}))

vi.mock('node:https', () => ({
  request: httpsRequest,
}))

const clearAuthEnv = () => {
  delete process.env.JANGAR_MARKET_CONTEXT_INGEST_TOKEN
  delete process.env.JANGAR_MARKET_CONTEXT_INGEST_ALLOW_SERVICE_ACCOUNT_TOKEN
  delete process.env.JANGAR_MARKET_CONTEXT_INGEST_ALLOWED_SERVICE_ACCOUNT_PREFIXES
}

const clearKubeServiceEnv = () => {
  delete process.env.KUBERNETES_SERVICE_HOST
  delete process.env.KUBERNETES_SERVICE_PORT
}

describe('market context ingest auth', () => {
  beforeEach(() => {
    vi.resetModules()
    createTokenReview.mockReset()
    loadFromCluster.mockReset()
    makeApiClient.mockReset()
    makeApiClient.mockReturnValue({ createTokenReview })
    readFileSync.mockReset()
    httpsRequest.mockReset()
    clearAuthEnv()
    clearKubeServiceEnv()
  })

  afterEach(() => {
    clearAuthEnv()
    clearKubeServiceEnv()
  })

  it('returns false when bearer token is missing', async () => {
    const { isMarketContextIngestAuthorized } = await import('../torghut-market-context-agents')

    const authorized = await isMarketContextIngestAuthorized(
      new Request('http://localhost/api/torghut/market-context/ingest', {
        method: 'POST',
      }),
    )

    expect(authorized).toBe(false)
    expect(createTokenReview).not.toHaveBeenCalled()
  })

  it('accepts static ingest token when configured', async () => {
    process.env.JANGAR_MARKET_CONTEXT_INGEST_TOKEN = 'ingest-secret-123'

    const { isMarketContextIngestAuthorized } = await import('../torghut-market-context-agents')

    const authorized = await isMarketContextIngestAuthorized(
      new Request('http://localhost/api/torghut/market-context/ingest', {
        method: 'POST',
        headers: {
          authorization: 'Bearer ingest-secret-123',
        },
      }),
    )

    expect(authorized).toBe(true)
    expect(createTokenReview).not.toHaveBeenCalled()
  })

  it('rejects static ingest token mismatch', async () => {
    process.env.JANGAR_MARKET_CONTEXT_INGEST_TOKEN = 'ingest-secret-123'
    process.env.JANGAR_MARKET_CONTEXT_INGEST_ALLOW_SERVICE_ACCOUNT_TOKEN = 'false'

    const { isMarketContextIngestAuthorized } = await import('../torghut-market-context-agents')

    const authorized = await isMarketContextIngestAuthorized(
      new Request('http://localhost/api/torghut/market-context/ingest', {
        method: 'POST',
        headers: {
          authorization: 'Bearer wrong-secret',
        },
      }),
    )

    expect(authorized).toBe(false)
    expect(createTokenReview).not.toHaveBeenCalled()
  })

  it('falls back to token review when static token mismatches and service account auth is enabled', async () => {
    process.env.JANGAR_MARKET_CONTEXT_INGEST_TOKEN = 'ingest-secret-123'
    process.env.JANGAR_MARKET_CONTEXT_INGEST_ALLOW_SERVICE_ACCOUNT_TOKEN = 'true'
    process.env.JANGAR_MARKET_CONTEXT_INGEST_ALLOWED_SERVICE_ACCOUNT_PREFIXES =
      'system:serviceaccount:agents:default,system:serviceaccount:agents:agents-sa'

    createTokenReview.mockResolvedValueOnce({
      body: {
        status: {
          authenticated: true,
          user: {
            username: 'system:serviceaccount:agents:default',
          },
        },
      },
    })

    const { isMarketContextIngestAuthorized } = await import('../torghut-market-context-agents')

    const authorized = await isMarketContextIngestAuthorized(
      new Request('http://localhost/api/torghut/market-context/ingest', {
        method: 'POST',
        headers: {
          authorization: 'Bearer k8s-sa-token',
        },
      }),
    )

    expect(authorized).toBe(true)
    expect(createTokenReview).toHaveBeenCalledTimes(1)
  })

  it('accepts agents service account token via TokenReview and correct request shape', async () => {
    process.env.JANGAR_MARKET_CONTEXT_INGEST_ALLOW_SERVICE_ACCOUNT_TOKEN = 'true'
    process.env.JANGAR_MARKET_CONTEXT_INGEST_ALLOWED_SERVICE_ACCOUNT_PREFIXES =
      'system:serviceaccount:agents:default,system:serviceaccount:agents:agents-sa'

    createTokenReview.mockResolvedValueOnce({
      body: {
        status: {
          authenticated: true,
          user: {
            username: 'system:serviceaccount:agents:agents-sa',
          },
        },
      },
    })

    const { isMarketContextIngestAuthorized } = await import('../torghut-market-context-agents')

    const authorized = await isMarketContextIngestAuthorized(
      new Request('http://localhost/api/torghut/market-context/ingest', {
        method: 'POST',
        headers: {
          authorization: 'Bearer k8s-sa-token',
        },
      }),
    )

    expect(authorized).toBe(true)
    expect(createTokenReview).toHaveBeenCalledTimes(1)
    expect(createTokenReview).toHaveBeenCalledWith({
      body: {
        apiVersion: 'authentication.k8s.io/v1',
        kind: 'TokenReview',
        spec: {
          token: 'k8s-sa-token',
        },
      },
    })
  })

  it('falls back to in-cluster https TokenReview when kubernetes client TLS verification fails', async () => {
    process.env.JANGAR_MARKET_CONTEXT_INGEST_ALLOW_SERVICE_ACCOUNT_TOKEN = 'true'
    process.env.JANGAR_MARKET_CONTEXT_INGEST_ALLOWED_SERVICE_ACCOUNT_PREFIXES = 'system:serviceaccount:agents:agents-sa'
    process.env.KUBERNETES_SERVICE_HOST = '10.96.0.1'
    process.env.KUBERNETES_SERVICE_PORT = '443'

    createTokenReview.mockRejectedValueOnce(new Error('unable to verify the first certificate'))
    readFileSync.mockImplementation((path: string) => {
      if (path.endsWith('/token')) return 'reviewer-token'
      if (path.endsWith('/ca.crt')) return 'reviewer-ca'
      throw new Error(`unexpected file path ${path}`)
    })

    httpsRequest.mockImplementationOnce((_, callback: (response: EventEmitter) => void) => {
      const request = new EventEmitter() as EventEmitter & { write: (chunk: string) => void; end: () => void }
      request.write = vi.fn()
      request.end = vi.fn(() => {
        const response = new EventEmitter() as EventEmitter & {
          statusCode?: number
          setEncoding: (encoding: string) => void
        }
        response.statusCode = 201
        response.setEncoding = vi.fn()
        callback(response)
        response.emit(
          'data',
          JSON.stringify({
            apiVersion: 'authentication.k8s.io/v1',
            kind: 'TokenReview',
            status: {
              authenticated: true,
              user: {
                username: 'system:serviceaccount:agents:agents-sa',
              },
            },
          }),
        )
        response.emit('end')
      })
      return request
    })

    const { isMarketContextIngestAuthorized } = await import('../torghut-market-context-agents')

    const authorized = await isMarketContextIngestAuthorized(
      new Request('http://localhost/api/torghut/market-context/ingest', {
        method: 'POST',
        headers: {
          authorization: 'Bearer k8s-sa-token',
        },
      }),
    )

    expect(authorized).toBe(true)
    expect(createTokenReview).toHaveBeenCalledTimes(1)
    expect(httpsRequest).toHaveBeenCalledTimes(1)
  })

  it('rejects token review usernames outside allowed service account prefixes', async () => {
    process.env.JANGAR_MARKET_CONTEXT_INGEST_ALLOW_SERVICE_ACCOUNT_TOKEN = 'true'
    process.env.JANGAR_MARKET_CONTEXT_INGEST_ALLOWED_SERVICE_ACCOUNT_PREFIXES =
      'system:serviceaccount:agents:default,system:serviceaccount:agents:agents-sa'

    createTokenReview.mockResolvedValueOnce({
      body: {
        status: {
          authenticated: true,
          user: {
            username: 'system:serviceaccount:jangar:default',
          },
        },
      },
    })

    const { isMarketContextIngestAuthorized } = await import('../torghut-market-context-agents')

    const authorized = await isMarketContextIngestAuthorized(
      new Request('http://localhost/api/torghut/market-context/ingest', {
        method: 'POST',
        headers: {
          authorization: 'Bearer k8s-sa-token',
        },
      }),
    )

    expect(authorized).toBe(false)
    expect(createTokenReview).toHaveBeenCalledTimes(1)
  })

  it('retries auth client initialization after a transient in-cluster config failure', async () => {
    process.env.JANGAR_MARKET_CONTEXT_INGEST_ALLOW_SERVICE_ACCOUNT_TOKEN = 'true'
    process.env.JANGAR_MARKET_CONTEXT_INGEST_ALLOWED_SERVICE_ACCOUNT_PREFIXES = 'system:serviceaccount:agents:default'

    loadFromCluster.mockImplementationOnce(() => {
      throw new Error('transient bootstrap failure')
    })
    loadFromCluster.mockImplementation(() => undefined)

    createTokenReview.mockResolvedValueOnce({
      body: {
        status: {
          authenticated: true,
          user: {
            username: 'system:serviceaccount:agents:default',
          },
        },
      },
    })

    const { isMarketContextIngestAuthorized } = await import('../torghut-market-context-agents')

    const firstAttempt = await isMarketContextIngestAuthorized(
      new Request('http://localhost/api/torghut/market-context/ingest', {
        method: 'POST',
        headers: {
          authorization: 'Bearer k8s-sa-token',
        },
      }),
    )
    const secondAttempt = await isMarketContextIngestAuthorized(
      new Request('http://localhost/api/torghut/market-context/ingest', {
        method: 'POST',
        headers: {
          authorization: 'Bearer k8s-sa-token',
        },
      }),
    )

    expect(firstAttempt).toBe(false)
    expect(secondAttempt).toBe(true)
    expect(loadFromCluster).toHaveBeenCalledTimes(2)
    expect(createTokenReview).toHaveBeenCalledTimes(1)
  })
})

describe('market context dispatch runtime', () => {
  it('uses runtime.config.serviceAccount when service account override is set', async () => {
    const { buildMarketContextAgentRunRuntime } = await import('../torghut-market-context-agents')

    const runtime = buildMarketContextAgentRunRuntime({
      runtimeType: 'job',
      runtimeServiceAccount: 'agents-sa',
    })

    expect(runtime).toEqual({
      type: 'job',
      config: {
        serviceAccount: 'agents-sa',
      },
    })
  })

  it('omits runtime config when service account override is empty', async () => {
    const { buildMarketContextAgentRunRuntime } = await import('../torghut-market-context-agents')

    const runtime = buildMarketContextAgentRunRuntime({
      runtimeType: 'job',
      runtimeServiceAccount: '',
    })

    expect(runtime).toEqual({
      type: 'job',
    })
  })
})
