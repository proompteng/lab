import { Clock, Effect, Ref } from 'effect'
import { HttpClient, type HttpClientResponse } from 'effect/http'

const accountLimit = 200
const minimumRequestCostMs = 600
export const brokerObservationQuotaWindowMs = 60_000
export const protectionReleaseReadCount = 4

export interface ProtectionReadAllowance {
  readonly expiresAtMs: number
  readonly requestCostMs: number
}

interface QuotaWindow {
  readonly expiresAtMs: number
  readonly limit: number
  readonly remaining: number
  readonly requestCostMs: number
}

interface PollBudgetState {
  readonly scheduledStartAtMs: number
  readonly requests: number
  readonly requestCostMs: number
  readonly quotaResetAtMs: number
  readonly limit: number
  readonly quotaResponses: number
  readonly quotaWindow: QuotaWindow | undefined
}

const nextPollAt = (current: PollBudgetState): number =>
  Math.max(current.scheduledStartAtMs + current.requests * current.requestCostMs, current.quotaResetAtMs)

const integer = (value: string | undefined): number | undefined => {
  if (value === undefined || !/^\d+$/.test(value)) return undefined
  const parsed = Number(value)
  return Number.isSafeInteger(parsed) ? parsed : undefined
}

const resetTime = (value: string | undefined): number => {
  if (value === undefined) return 0
  const seconds = integer(value)
  const millis = seconds === undefined ? Date.parse(value) : seconds * 1_000
  return Number.isSafeInteger(millis) ? millis : 0
}

export const protectionReadBackoffUntil = (response: HttpClientResponse.HttpClientResponse, now: number) => {
  const retry = response.headers['retry-after']
  const seconds = integer(retry)
  const retryTime = seconds === undefined ? resetTime(retry) : now + seconds * 1_000
  const retryAt = Number.isSafeInteger(retryTime) ? retryTime : 0
  const resetAt = resetTime(response.headers['x-ratelimit-reset'])
  if (response.status === 429) return Math.max(retryAt, resetAt > now ? resetAt : now + brokerObservationQuotaWindowMs)
  return retryAt > now ? retryAt : 0
}

export const makeBrokerObservationBudget = Effect.gen(function* () {
  const state = yield* Ref.make<PollBudgetState>({
    scheduledStartAtMs: yield* Clock.currentTimeMillis,
    requests: 0,
    requestCostMs: minimumRequestCostMs,
    quotaResetAtMs: 0,
    limit: accountLimit,
    quotaResponses: 0,
    quotaWindow: undefined,
  })
  const reserve = Effect.gen(function* () {
    while (true) {
      const now = yield* Clock.currentTimeMillis
      const delayMs = yield* Ref.modify(state, (current) => {
        if (current.quotaResetAtMs > now) return [current.quotaResetAtMs - now, current]
        return current.quotaResetAtMs > 0
          ? [
              0,
              {
                ...current,
                scheduledStartAtMs: Math.max(now, nextPollAt(current)),
                requests: 1,
                quotaResetAtMs: 0,
                quotaResponses: 0,
                quotaWindow: undefined,
              },
            ]
          : [0, { ...current, requests: current.requests + 1 }]
      })
      if (delayMs === 0) return
      yield* Effect.sleep(delayMs)
    }
  })
  const observe = (response: HttpClientResponse.HttpClientResponse) =>
    Effect.gen(function* () {
      const now = yield* Clock.currentTimeMillis
      const reportedLimit = integer(response.headers['x-ratelimit-limit'])
      const remaining = integer(response.headers['x-ratelimit-remaining'])
      const windowEndsAt = resetTime(response.headers['x-ratelimit-reset'])
      const retrySeconds = integer(response.headers['retry-after'])
      const retryTime =
        retrySeconds === undefined ? resetTime(response.headers['retry-after']) : now + retrySeconds * 1_000
      const retryAtMs = Number.isSafeInteger(retryTime) ? retryTime : 0
      const resetAtMs = Math.max(windowEndsAt, retryAtMs)
      yield* Ref.update(state, (current) => {
        const limit = reportedLimit === undefined || reportedLimit === 0 ? current.limit : reportedLimit
        const requestCostMs = Math.max(minimumRequestCostMs, Math.ceil((brokerObservationQuotaWindowMs * 2) / limit))
        const depleted =
          response.status === 429 || (remaining !== undefined && remaining <= Math.max(1, Math.floor(limit / 4)))
        const attested =
          response.status >= 200 &&
          response.status < 300 &&
          retryAtMs <= now &&
          reportedLimit !== undefined &&
          reportedLimit > 0 &&
          remaining !== undefined &&
          remaining <= reportedLimit &&
          windowEndsAt > now &&
          windowEndsAt <= now + brokerObservationQuotaWindowMs
        const window = current.quotaWindow
        // Responses can complete out of order. Keep a conservative lower bound across the capture.
        const quotaWindow = attested
          ? {
              expiresAtMs: Math.min(window?.expiresAtMs ?? windowEndsAt, windowEndsAt),
              limit: Math.max(window?.limit ?? reportedLimit, reportedLimit),
              remaining: Math.min(window?.remaining ?? remaining, remaining),
              requestCostMs: Math.max(window?.requestCostMs ?? requestCostMs, requestCostMs),
            }
          : window
        return {
          ...current,
          limit,
          requestCostMs,
          quotaResponses: current.quotaResponses + (attested ? 1 : 0),
          quotaWindow,
          quotaResetAtMs: Math.max(
            current.quotaResetAtMs,
            depleted ? (resetAtMs > now ? resetAtMs : now + brokerObservationQuotaWindowMs) : 0,
          ),
        }
      })
    })
  return {
    beginCapture: Effect.gen(function* () {
      while (true) {
        const now = yield* Clock.currentTimeMillis
        const delayMs = yield* Ref.modify(state, (current) =>
          nextPollAt(current) > now
            ? [nextPollAt(current) - now, current]
            : [
                0,
                {
                  ...current,
                  scheduledStartAtMs: now,
                  requests: 0,
                  quotaResetAtMs: 0,
                  quotaResponses: 0,
                  quotaWindow: undefined,
                },
              ],
        )
        if (delayMs === 0) return
        yield* Effect.sleep(delayMs)
      }
    }),
    decorate: (client: HttpClient.HttpClient): HttpClient.HttpClient =>
      HttpClient.transform(client, (response) => reserve.pipe(Effect.andThen(response), Effect.tap(observe))),
    nextPollNotBeforeMs: Effect.map(Ref.get(state), nextPollAt),
    protectionReadAllowance: Effect.gen(function* () {
      const now = yield* Clock.currentTimeMillis
      const current = yield* Ref.get(state)
      const window = current.quotaWindow
      if (
        window === undefined ||
        current.quotaResetAtMs > now ||
        window.expiresAtMs <= now ||
        window.remaining - (current.requests - current.quotaResponses) - protectionReleaseReadCount <
          Math.ceil(window.limit / 4)
      )
        return undefined
      return {
        expiresAtMs: window.expiresAtMs,
        requestCostMs: window.requestCostMs,
      } satisfies ProtectionReadAllowance
    }),
  }
})
