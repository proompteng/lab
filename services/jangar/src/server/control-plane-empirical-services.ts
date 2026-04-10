import { resolveControlPlaneStatusConfig } from '~/server/control-plane-config'
import { asRecord, asString } from '~/server/primitives-http'
import type { EmpiricalDependencyStatus, EmpiricalServicesStatus } from './control-plane-status-types'

const requestJson = async (url: string): Promise<Record<string, unknown> | null> => {
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), 2000)
  try {
    const response = await fetch(url, {
      method: 'GET',
      headers: { accept: 'application/json' },
      signal: controller.signal,
    })
    const payload = (await response.json().catch(() => null)) as unknown
    if (!response.ok || !payload || typeof payload !== 'object' || Array.isArray(payload)) {
      return null
    }
    return payload as Record<string, unknown>
  } catch {
    return null
  } finally {
    clearTimeout(timeout)
  }
}

const readStatus = (payload: Record<string, unknown> | null): EmpiricalDependencyStatus['status'] =>
  payload && typeof payload.status === 'string' ? (payload.status as EmpiricalDependencyStatus['status']) : 'degraded'

export const resolveEmpiricalServices = async (): Promise<EmpiricalServicesStatus> => {
  const statusUrl = resolveControlPlaneStatusConfig(process.env).torghutStatusUrl
  if (!statusUrl) {
    return {
      forecast: {
        status: 'disabled',
        endpoint: '',
        message: 'torghut status not configured',
        authoritative: false,
      },
      lean: {
        status: 'disabled',
        endpoint: '',
        message: 'torghut status not configured',
        authoritative: false,
      },
      jobs: {
        status: 'disabled',
        endpoint: '',
        message: 'torghut status not configured',
        authoritative: false,
      },
    }
  }

  const payload = await requestJson(statusUrl)
  if (!payload) {
    const degraded = {
      status: 'degraded' as const,
      endpoint: statusUrl,
      message: 'torghut status unavailable',
      authoritative: false,
    }
    return {
      forecast: degraded,
      lean: degraded,
      jobs: degraded,
    }
  }

  const forecastPayload = asRecord(payload.forecast_service)
  const leanPayload = asRecord(payload.lean_authority)
  const jobsPayload = asRecord(payload.empirical_jobs)
  const jobsMap = asRecord(jobsPayload?.jobs)
  const eligibleJobs = Object.entries(jobsMap ?? {})
    .filter(([, value]) => {
      const row = asRecord(value)
      return row?.promotion_authority_eligible === true
    })
    .map(([key]) => key)
  const staleJobs = Object.entries(jobsMap ?? {})
    .filter(([, value]) => {
      const row = asRecord(value)
      return row?.stale === true
    })
    .map(([key]) => key)

  return {
    forecast: {
      status: readStatus(forecastPayload),
      endpoint: statusUrl,
      message:
        forecastPayload && typeof forecastPayload.message === 'string'
          ? forecastPayload.message
          : 'forecast status unavailable',
      authoritative: forecastPayload?.authority === 'empirical',
      calibration_status:
        forecastPayload && typeof forecastPayload.calibration_status === 'string'
          ? forecastPayload.calibration_status
          : 'unknown',
      eligible_models: Array.isArray(forecastPayload?.promotion_authority_eligible_models)
        ? forecastPayload.promotion_authority_eligible_models.filter(
            (item): item is string => typeof item === 'string' && item.length > 0,
          )
        : [],
    },
    lean: {
      status: readStatus(leanPayload),
      endpoint: statusUrl,
      message: leanPayload && typeof leanPayload.message === 'string' ? leanPayload.message : 'lean status unavailable',
      authoritative: leanPayload?.authority === 'empirical',
      authoritative_modes: Array.isArray(leanPayload?.authoritative_modes)
        ? leanPayload.authoritative_modes.filter((item): item is string => typeof item === 'string' && item.length > 0)
        : [],
    },
    jobs: {
      status: readStatus(jobsPayload),
      endpoint: statusUrl,
      message:
        staleJobs.length > 0
          ? `stale empirical jobs: ${staleJobs.join(', ')}`
          : typeof jobsPayload?.message === 'string'
            ? jobsPayload.message
            : 'empirical jobs status unavailable',
      authoritative: jobsPayload?.authority === 'empirical',
      eligible_jobs: eligibleJobs,
      stale_jobs: staleJobs,
    },
  }
}
