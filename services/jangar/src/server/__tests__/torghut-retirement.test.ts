import { describe, expect, it, vi } from 'vitest'

import { createJangarHttpRuntime } from '~/server/http-runtime'
import { resolveJangarRuntimeProfile } from '~/server/runtime-profile'
import {
  resolveTorghutDecisionEngineConfig,
  resolveTorghutQuantRuntimeConfig,
  resolveTorghutTradingDatabaseConfig,
} from '~/server/torghut-config'
import { resolveMarketContextRuntimeConfig, validateMarketContextConfig } from '~/server/torghut-market-context-config'
import { guardRetiredTorghutRoute } from '~/server/torghut-retirement'
import { resolveWhitepaperControlConfig } from '~/server/whitepaper-config'

vi.mock('~/server/kysely-migrations', () => ({ ensureMigrations: vi.fn() }))
vi.mock('crossws/adapters/bun', () => ({ default: () => ({ websocket: {}, handleUpgrade: vi.fn() }) }))

const retired = { JANGAR_TORGHUT_LEGACY_RETIRED: 'true' }

describe('Torghut runtime retirement', () => {
  it.each([
    '/api/torghut/trading/summary',
    '/api/torghut/decision-engine/runs',
    '/api/torghut/simulation',
    '/api/whitepapers/$runId',
  ])('returns 410 before invoking a retired route handler: %s', async (routePath) => {
    const handler = vi.fn(() => Response.json({ unexpected: true }))
    const runtime = await createJangarHttpRuntime({
      routeSources: { 'route.ts': `createFileRoute('${routePath}')({ server: {} })` },
      routeModules: {
        'route.ts': async () => ({ Route: { options: { server: { handlers: { GET: handler, POST: handler } } } } }),
      },
      routeGuard: (path) => guardRetiredTorghutRoute(path, retired),
      serveClient: false,
    })
    for (const method of ['GET', 'POST']) {
      const response = await runtime.handleRequest(
        new Request(`http://localhost${routePath.replace('$runId', 'run-1')}/`, { method }),
      )
      expect(response.status).toBe(410)
      expect(await response.json()).toMatchObject({ error: 'torghut_runtime_retired' })
    }
    expect(handler).not.toHaveBeenCalled()
  })

  it.each([
    '/api/torghut/symbols',
    '/api/torghut/ta/bars',
    '/api/torghut/market-context/health',
    '/api/whitepapers-other',
    '/health',
  ])('preserves unrelated and retained routes: %s', async (routePath) => {
    const handler = vi.fn(() => Response.json({ retained: true }))
    const runtime = await createJangarHttpRuntime({
      routeSources: { 'route.ts': `createFileRoute('${routePath}')({ server: {} })` },
      routeModules: { 'route.ts': async () => ({ Route: { options: { server: { handlers: { GET: handler } } } } }) },
      routeGuard: (path) => guardRetiredTorghutRoute(path, retired),
      serveClient: false,
    })
    expect((await runtime.handleRequest(new Request(`http://localhost${routePath}`))).status).toBe(200)
    expect(handler).toHaveBeenCalledOnce()
  })

  it('leaves legacy routes available when retirement has not been enabled', () => {
    expect(guardRetiredTorghutRoute('/api/torghut/trading/summary', {})).toBeUndefined()
    expect(guardRetiredTorghutRoute('/api/whitepapers', { JANGAR_TORGHUT_LEGACY_RETIRED: 'false' })).toBeUndefined()
  })

  it('prevents legacy startup, database access, and overrides from re-enabling consumers', () => {
    const env = {
      ...retired,
      TORGHUT_DB_DSN: 'postgres://unused.invalid/retired',
      JANGAR_TORGHUT_QUANT_CONTROL_PLANE_ENABLED: 'true',
      JANGAR_TORGHUT_QUANT_ALERTS_ENABLED: 'true',
      JANGAR_TORGHUT_DECISION_ENGINE_ENABLED: 'true',
      JANGAR_WHITEPAPER_FINALIZE_ENABLED: 'true',
    }
    expect(resolveTorghutTradingDatabaseConfig(env).dsn).toBeNull()
    expect(resolveTorghutQuantRuntimeConfig(env, { enabled: true, alertsEnabled: true })).toMatchObject({
      enabled: false,
      alertsEnabled: false,
    })
    expect(resolveTorghutDecisionEngineConfig(env).enabled).toBe(false)
    expect(resolveWhitepaperControlConfig(env).enabled).toBe(false)
    for (const JANGAR_SERVER_PROFILE of ['http-server', 'vite-dev-api', 'test']) {
      expect(resolveJangarRuntimeProfile({ ...env, JANGAR_SERVER_PROFILE }).startup).toEqual({
        torghutQuantRuntime: false,
        whitepaperFinalizeConsumer: false,
      })
    }
  })

  it('keeps market-context batches gated without querying the retired status endpoint', () => {
    const env = { ...retired, JANGAR_MARKET_CONTEXT_BATCH_TRADING_STATUS_URL: 'http://retired.invalid/trading/status' }
    expect(resolveMarketContextRuntimeConfig(env)).toMatchObject({
      batchTradingStatusUrl: '',
      batchRequireOpenSession: true,
    })
    expect(() => validateMarketContextConfig(env)).not.toThrow()
  })
})
