import type { KhoshutConfig } from './config'

type FetchLike = typeof fetch
type DelayLike = (ms: number) => Promise<void>
type NowLike = () => number
type LoggerLike = Pick<typeof console, 'warn'>

type InngestHealthStatus = {
  ok: boolean
  url: string
  message: string
  status?: number
}

const delay: DelayLike = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

const buildInngestHealthUrl = (baseUrl: string): string => new URL('/health', baseUrl).toString()

const buildTimeoutSignal = (timeoutMs: number): AbortSignal | undefined => {
  if (typeof AbortSignal === 'undefined' || typeof AbortSignal.timeout !== 'function') {
    return undefined
  }
  return AbortSignal.timeout(timeoutMs)
}

export const checkInngestHealth = async (
  config: Pick<KhoshutConfig, 'baseUrl' | 'startupRequestTimeoutMs'>,
  fetchImpl: FetchLike = fetch,
): Promise<InngestHealthStatus> => {
  const url = buildInngestHealthUrl(config.baseUrl)

  try {
    const response = await fetchImpl(url, {
      method: 'GET',
      headers: {
        accept: 'application/json',
      },
      signal: buildTimeoutSignal(config.startupRequestTimeoutMs),
    })

    if (!response.ok) {
      return {
        ok: false,
        url,
        status: response.status,
        message: `health endpoint returned HTTP ${response.status}`,
      }
    }

    return {
      ok: true,
      url,
      status: response.status,
      message: 'ok',
    }
  } catch (error) {
    return {
      ok: false,
      url,
      message: error instanceof Error ? error.message : String(error),
    }
  }
}

export const waitForInngestHealthy = async (
  config: Pick<KhoshutConfig, 'baseUrl' | 'startupTimeoutMs' | 'startupCheckIntervalMs' | 'startupRequestTimeoutMs'>,
  options: {
    fetchImpl?: FetchLike
    delayImpl?: DelayLike
    now?: NowLike
    logger?: LoggerLike
  } = {},
): Promise<void> => {
  const fetchImpl = options.fetchImpl ?? fetch
  const delayImpl = options.delayImpl ?? delay
  const now = options.now ?? Date.now
  const logger = options.logger ?? console
  const deadline = now() + config.startupTimeoutMs
  let attempt = 0
  let lastFailure: InngestHealthStatus | null = null

  while (now() <= deadline) {
    attempt += 1
    const status = await checkInngestHealth(config, fetchImpl)
    if (status.ok) {
      return
    }

    lastFailure = status
    const remainingMs = Math.max(0, deadline - now())
    logger.warn(
      `[khoshut] Inngest health check attempt ${attempt} failed for ${status.url}: ${status.message} (remaining ${remainingMs}ms)`,
    )

    if (remainingMs === 0) {
      break
    }

    await delayImpl(Math.min(config.startupCheckIntervalMs, remainingMs))
  }

  const detail = lastFailure
    ? `${lastFailure.url} (${lastFailure.status ?? 'no-status'}): ${lastFailure.message}`
    : 'no attempts were executed'
  throw new Error(`Timed out waiting for Inngest health after ${config.startupTimeoutMs}ms: ${detail}`)
}
