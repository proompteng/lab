import { describe, expect, it } from 'vitest'

import {
  resolveTorghutEndpointsConfig,
  resolveTorghutQuantRuntimeConfig,
  validateTorghutConfig,
} from '~/server/torghut-config'

describe('torghut-config', () => {
  it('parses quant runtime settings and policy thresholds', () => {
    const config = resolveTorghutQuantRuntimeConfig({
      JANGAR_TORGHUT_QUANT_CONTROL_PLANE_ENABLED: 'true',
      JANGAR_TORGHUT_QUANT_COMPUTE_INTERVAL_MS: '2500',
      JANGAR_TORGHUT_QUANT_WINDOWS_LIGHT: '1m,15m',
      JANGAR_TORGHUT_QUANT_POLICY_MAX_DRAWDOWN_1D: '0.08',
    })

    expect(config.enabled).toBe(true)
    expect(config.computeIntervalMs).toBe(2500)
    expect(config.windowsLight).toEqual(['1m', '15m'])
    expect(config.policy.maxDrawdown1d).toBe(0.08)
  })

  it('normalizes torghut endpoints and health defaults', () => {
    expect(
      resolveTorghutEndpointsConfig({
        TORGHUT_API_BASE_URL: 'https://torghut.example.com///',
        JANGAR_TORGHUT_STATUS_URL: 'https://torghut.example.com/status///',
        JANGAR_MARKET_CONTEXT_HEALTH_DEFAULT_SYMBOL: ' msft ',
        JANGAR_TORGHUT_QUANT_HEALTH_MISSING_UPDATE_SECONDS: '25',
      }),
    ).toEqual({
      apiBaseUrl: 'https://torghut.example.com',
      statusUrl: 'https://torghut.example.com/status',
      marketContextHealthDefaultSymbol: 'MSFT',
      quantHealthMissingUpdateSeconds: 25,
    })
  })

  it('rejects invalid torghut URLs during validation', () => {
    expect(() =>
      validateTorghutConfig({
        TORGHUT_API_BASE_URL: 'http://torghut.example.com',
        JANGAR_TORGHUT_STATUS_URL: '://bad-url',
      }),
    ).toThrow()
  })
})
