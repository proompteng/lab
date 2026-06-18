import { describe, expect, it } from 'bun:test'

import { classifyReadyzForPostDeployRetry } from '../readyz-contract'

const repairOnlyReadyz = {
  status: 'degraded',
  scheduler: { ok: true, running: true },
  dependencies: {
    postgres: { ok: true, detail: 'ok' },
    clickhouse: { ok: true, detail: 'ok' },
    database: { ok: true, detail: 'ok' },
    live_submission_gate: { ok: false, detail: 'simple_submit_disabled' },
    profitability_proof_floor: { ok: false, detail: 'repair_only', capital_state: 'zero_notional' },
  },
}

const coreDependenciesOnlyReadyz = {
  status: 'degraded',
  scheduler: { ok: true, running: true },
  readiness_surface: 'core_dependencies_only',
  dependencies: {
    postgres: { ok: true, detail: 'ok' },
    clickhouse: { ok: true, detail: 'ok' },
    database: { ok: true, detail: 'ok' },
    alpaca: { ok: false, detail: 'alpaca account probe timed out after 2.00s' },
  },
  live_submission_gate: {
    allowed: false,
    promotion_authority: false,
    promotion_authority_ok: false,
    final_authority_ok: false,
    final_promotion_allowed: false,
    final_promotion_authorized: false,
    reason: 'readyz_core_dependencies_only',
    reason_codes: ['readyz_core_dependencies_only'],
    blocked_reasons: ['readyz_core_dependencies_only'],
    read_model_evaluated: false,
    readiness_surface: 'core_dependencies_only',
    live_submit_activation: {
      configured: true,
      valid: true,
      expired: false,
      expires_at: '2030-06-17T20:05:00+00:00',
    },
  },
}

describe('classifyReadyzForPostDeployRetry', () => {
  it('accepts healthy 2xx readyz payloads immediately', () => {
    expect(
      classifyReadyzForPostDeployRetry({
        httpStatus: '200',
        readyz: { status: 'ok' },
      }),
    ).toBe('acceptable')
  })

  it('accepts repair-only 503 only when runtime database dependencies are healthy', () => {
    expect(
      classifyReadyzForPostDeployRetry({
        httpStatus: '503',
        readyz: repairOnlyReadyz,
      }),
    ).toBe('acceptable')
  })

  it('accepts core-dependencies-only 503 when runtime dependencies are healthy and the top-level gate is closed', () => {
    expect(
      classifyReadyzForPostDeployRetry({
        httpStatus: '503',
        readyz: coreDependenciesOnlyReadyz,
      }),
    ).toBe('acceptable')
  })

  it('rejects core-dependencies-only 503 when the readiness gate carries authority', () => {
    expect(
      classifyReadyzForPostDeployRetry({
        httpStatus: '503',
        readyz: {
          ...coreDependenciesOnlyReadyz,
          live_submission_gate: {
            ...coreDependenciesOnlyReadyz.live_submission_gate,
            final_promotion_allowed: true,
          },
        },
      }),
    ).toBe('unacceptable')
  })

  it('retries a degraded 503 when the database contract only shows a statement timeout', () => {
    expect(
      classifyReadyzForPostDeployRetry({
        httpStatus: '503',
        readyz: {
          ...repairOnlyReadyz,
          reason: 'readyz_evaluation_timeout',
          dependencies: {
            ...repairOnlyReadyz.dependencies,
            database: {
              ok: false,
              detail: 'database contract failed',
              schema_current: false,
              account_scope_ready: false,
              account_scope_errors: [
                '(psycopg.errors.QueryCanceled) canceling statement due to statement timeout\n' +
                  '[SQL: SELECT alembic_version.version_num FROM alembic_version]',
              ],
            },
          },
        },
      }),
    ).toBe('retryable_database_timeout')
  })

  it('does not retry real database reachability failures', () => {
    expect(
      classifyReadyzForPostDeployRetry({
        httpStatus: '503',
        readyz: {
          ...repairOnlyReadyz,
          dependencies: {
            ...repairOnlyReadyz.dependencies,
            database: {
              ok: false,
              detail: 'database unavailable',
              error: 'connection refused',
              schema_current: false,
            },
          },
        },
      }),
    ).toBe('unacceptable')
  })

  it('does not retry schema drift because migrations remain fail-closed', () => {
    expect(
      classifyReadyzForPostDeployRetry({
        httpStatus: '503',
        readyz: {
          ...repairOnlyReadyz,
          dependencies: {
            ...repairOnlyReadyz.dependencies,
            database: {
              ok: false,
              detail: 'database contract failed',
              schema_current: false,
              schema_missing_heads: ['0048_required_head'],
              schema_unexpected_heads: ['0047_old_head'],
            },
          },
        },
      }),
    ).toBe('unacceptable')
  })
})
