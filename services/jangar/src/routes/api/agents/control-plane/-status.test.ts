import { beforeEach, describe, expect, it, vi } from 'vitest'

const resolveGrpcStatus = vi.fn()
const buildControlPlaneStatus = vi.fn()
const getQuantHealthHandler = vi.fn()

vi.mock('~/server/control-plane-grpc', () => ({
  resolveGrpcStatus,
}))

vi.mock('~/server/control-plane-status', () => ({
  buildControlPlaneStatus,
}))

vi.mock('../torghut/trading/control-plane/quant/health', () => ({
  getQuantHealthHandler,
}))

describe('getControlPlaneStatus', () => {
  beforeEach(() => {
    resolveGrpcStatus.mockReset()
    buildControlPlaneStatus.mockReset()
    getQuantHealthHandler.mockReset()

    resolveGrpcStatus.mockResolvedValue({ ok: true })
    buildControlPlaneStatus.mockResolvedValue({
      ok: true,
      namespace: 'agents',
      dependencies: {
        temporal: {
          ok: true,
        },
      },
    })
  })

  it('returns control-plane status without quant evidence when trading scope is absent', async () => {
    const { getControlPlaneStatus } = await import('./status')
    const response = await getControlPlaneStatus(new Request('http://localhost/api/agents/control-plane/status'))

    expect(response.status).toBe(200)
    expect(buildControlPlaneStatus).toHaveBeenCalledWith({
      namespace: 'agents',
      grpc: { ok: true },
    })
    expect(getQuantHealthHandler).not.toHaveBeenCalled()

    const body = await response.json()
    expect(body.ok).toBe(true)
    expect(body.quant_evidence).toBeUndefined()
  })

  it('embeds quant evidence when account and window are provided', async () => {
    getQuantHealthHandler.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          ok: true,
          status: 'degraded',
          account: 'paper',
          window: '15m',
        }),
        {
          status: 200,
          headers: {
            'content-type': 'application/json',
          },
        },
      ),
    )

    const { getControlPlaneStatus } = await import('./status')
    const response = await getControlPlaneStatus(
      new Request('http://localhost/api/agents/control-plane/status?namespace=agents&account=paper&window=15m', {
        headers: {
          'x-test-header': 'present',
        },
      }),
    )

    expect(response.status).toBe(200)
    expect(getQuantHealthHandler).toHaveBeenCalledTimes(1)

    const quantRequest = getQuantHealthHandler.mock.calls[0]?.[0]
    expect(quantRequest).toBeInstanceOf(Request)
    expect(quantRequest.url).toBe(
      'http://localhost/api/torghut/trading/control-plane/quant/health?account=paper&window=15m',
    )
    expect(quantRequest.headers.get('x-test-header')).toBe('present')

    const body = await response.json()
    expect(body.ok).toBe(true)
    expect(body.quant_evidence).toEqual({
      ok: true,
      status: 'degraded',
      account: 'paper',
      window: '15m',
    })
  })
})
