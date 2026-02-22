import { beforeEach, describe, expect, it, vi } from 'vitest'

const listQuantAlerts = vi.fn()

vi.mock('~/server/torghut-quant-metrics-store', () => ({
  listQuantAlerts,
}))

describe('getQuantAlertsHandler', () => {
  beforeEach(() => {
    listQuantAlerts.mockReset()
  })

  it('returns 400 when strategy_id is invalid', async () => {
    const { getQuantAlertsHandler } = await import('./alerts')

    const response = await getQuantAlertsHandler(
      new Request('http://localhost/api/torghut/trading/control-plane/quant/alerts?strategy_id=not-a-uuid'),
    )

    expect(response.status).toBe(400)
    expect(listQuantAlerts).not.toHaveBeenCalled()

    const body = await response.json()
    expect(body).toEqual({ ok: false, message: 'strategy_id must be a UUID' })
  })

  it('returns 400 when state is invalid', async () => {
    const { getQuantAlertsHandler } = await import('./alerts')

    const response = await getQuantAlertsHandler(
      new Request('http://localhost/api/torghut/trading/control-plane/quant/alerts?state=bad'),
    )

    expect(response.status).toBe(400)
    expect(listQuantAlerts).not.toHaveBeenCalled()

    const body = await response.json()
    expect(body).toEqual({ ok: false, message: 'state must be one of: open, resolved' })
  })

  it('lists alerts across strategies when strategy_id is omitted', async () => {
    const { getQuantAlertsHandler } = await import('./alerts')

    listQuantAlerts.mockResolvedValueOnce([{ alertId: 'a-1' }])

    const response = await getQuantAlertsHandler(
      new Request('http://localhost/api/torghut/trading/control-plane/quant/alerts'),
    )

    expect(response.status).toBe(200)
    expect(listQuantAlerts).toHaveBeenCalledWith({ strategyId: undefined, state: undefined })

    const body = await response.json()
    expect(body).toEqual({ ok: true, alerts: [{ alertId: 'a-1' }] })
  })
})
