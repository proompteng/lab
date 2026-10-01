import { Clock, Effect, Ref, Semaphore } from 'effect'
import { HttpClient, type HttpClientResponse } from 'effect/http'

const accountLimit = 200
const minimumSpacingMs = 600
const quotaWindowMs = 60_000

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

export const makeBrokerObservationBudget = Effect.gen(function* () {
  const state = yield* Ref.make({ nextRequestAtMs: 0, spacingMs: minimumSpacingMs, limit: accountLimit })
  const reservations = yield* Semaphore.make(1)
  const reserve = reservations.withPermit(
    Effect.gen(function* () {
      while (true) {
        const now = yield* Clock.currentTimeMillis
        const delayMs = yield* Ref.modify(state, (current) =>
          current.nextRequestAtMs > now
            ? [current.nextRequestAtMs - now, current]
            : [0, { ...current, nextRequestAtMs: now + current.spacingMs }],
        )
        if (delayMs === 0) return
        yield* Effect.sleep(delayMs)
      }
    }),
  )
  const observe = (response: HttpClientResponse.HttpClientResponse) =>
    Effect.gen(function* () {
      const now = yield* Clock.currentTimeMillis
      const reportedLimit = integer(response.headers['x-ratelimit-limit'])
      const remaining = integer(response.headers['x-ratelimit-remaining'])
      const retrySeconds = integer(response.headers['retry-after'])
      const retryTime =
        retrySeconds === undefined ? resetTime(response.headers['retry-after']) : now + retrySeconds * 1_000
      const retryAtMs = Number.isSafeInteger(retryTime) ? retryTime : 0
      const resetAtMs = Math.max(resetTime(response.headers['x-ratelimit-reset']), retryAtMs)
      yield* Ref.update(state, (current) => {
        const limit = reportedLimit === undefined || reportedLimit === 0 ? current.limit : reportedLimit
        const spacingMs = Math.max(minimumSpacingMs, Math.ceil((quotaWindowMs * 2) / limit))
        const depleted =
          response.status === 429 || (remaining !== undefined && remaining <= Math.max(1, Math.floor(limit / 4)))
        return {
          limit,
          spacingMs,
          nextRequestAtMs: Math.max(
            current.nextRequestAtMs,
            spacingMs > current.spacingMs ? now + spacingMs : 0,
            depleted ? (resetAtMs > now ? resetAtMs : now + quotaWindowMs) : 0,
          ),
        }
      })
    })
  return {
    decorate: (client: HttpClient.HttpClient): HttpClient.HttpClient =>
      HttpClient.transform(client, (response) => reserve.pipe(Effect.andThen(response), Effect.tap(observe))),
    nextPollNotBeforeMs: Effect.map(Ref.get(state), (current) => current.nextRequestAtMs),
  }
})
