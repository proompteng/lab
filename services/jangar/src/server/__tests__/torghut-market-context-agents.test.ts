import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const createTokenReview = vi.fn()
const loadFromCluster = vi.fn()
const makeApiClient = vi.fn(() => ({ createTokenReview }))

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

const clearAuthEnv = () => {
  delete process.env.JANGAR_MARKET_CONTEXT_INGEST_TOKEN
  delete process.env.JANGAR_MARKET_CONTEXT_INGEST_ALLOW_SERVICE_ACCOUNT_TOKEN
  delete process.env.JANGAR_MARKET_CONTEXT_INGEST_ALLOWED_SERVICE_ACCOUNT_PREFIXES
}

describe('market context ingest auth', () => {
  beforeEach(() => {
    vi.resetModules()
    createTokenReview.mockReset()
    loadFromCluster.mockReset()
    makeApiClient.mockReset()
    makeApiClient.mockReturnValue({ createTokenReview })
    clearAuthEnv()
  })

  afterEach(() => {
    clearAuthEnv()
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
