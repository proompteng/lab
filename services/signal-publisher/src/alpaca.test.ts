import { describe, expect, test } from 'bun:test'

import { Effect, Redacted } from 'effect'
import { HttpClient, HttpClientResponse } from 'effect/unstable/http'

import { fetchBars, fetchCalendar } from './alpaca'
import type { PublisherConfig } from './config'

const config: PublisherConfig = {
  clickhouse: {
    url: 'http://clickhouse.test',
    username: 'publisher',
    password: Redacted.make('password'),
  },
  alpaca: {
    dataUrl: 'https://data.alpaca.test',
    tradingUrl: 'https://trading.alpaca.test',
    key: Redacted.make('key'),
    secret: Redacted.make('secret'),
    feed: 'iex',
  },
  symbols: ['SPY', 'TLT'],
  startDate: '2026-07-16',
  calendarVersion: 'alpaca-us-equity-calendar-v1',
  finalizationLagMinutes: 90,
  operationTimeoutMs: 1_000,
  provenance: {
    sourceRevision: 'a'.repeat(40),
    imageRepository: 'registry.ide-newton.ts.net/lab/signal-publisher',
    imageDigest: `sha256:${'b'.repeat(64)}`,
  },
}

const jsonResponse = (request: Parameters<typeof HttpClientResponse.fromWeb>[0], body: unknown, status = 200) =>
  HttpClientResponse.fromWeb(
    request,
    new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } }),
  )

describe('Alpaca HTTP client', () => {
  test('requests explicit adjusted feed semantics and follows pagination', async () => {
    const requests: URL[] = []
    const client = HttpClient.make((request, url) => {
      requests.push(url)
      const next = url.searchParams.get('page_token')
      return Effect.succeed(
        jsonResponse(request, {
          bars: {
            [next ? 'TLT' : 'SPY']: [
              {
                t: '2026-07-17T04:00:00Z',
                o: next ? 89 : 620,
                h: next ? 91 : 622,
                l: next ? 88 : 619,
                c: next ? 90 : 621,
                v: 1_000,
                n: 10,
                vw: next ? 90 : 621,
              },
            ],
          },
          next_page_token: next ? null : 'page-2',
        }),
      )
    })

    const bars = await Effect.runPromise(
      fetchBars(config, '2026-07-16', '2026-07-17').pipe(Effect.provideService(HttpClient.HttpClient, client)),
    )

    expect(Object.keys(bars)).toEqual(['SPY', 'TLT'])
    expect(requests).toHaveLength(2)
    expect(requests[0].searchParams.get('adjustment')).toBe('all')
    expect(requests[0].searchParams.get('feed')).toBe('iex')
    expect(requests[0].searchParams.get('asof')).toBe('2026-07-17')
    expect(requests[1].searchParams.get('page_token')).toBe('page-2')
  })

  test('runtime-decodes calendar responses and maps provider failures', async () => {
    const validClient = HttpClient.make((request) =>
      Effect.succeed(jsonResponse(request, [{ date: '2026-07-17', open: '09:30', close: '16:00' }])),
    )
    const calendar = await Effect.runPromise(
      fetchCalendar(config, '2026-07-17', '2026-07-17').pipe(Effect.provideService(HttpClient.HttpClient, validClient)),
    )
    expect(calendar).toEqual([{ date: '2026-07-17', open: '09:30', close: '16:00' }])

    const failingClient = HttpClient.make((request) =>
      Effect.succeed(jsonResponse(request, { message: 'rate limited' }, 429)),
    )
    const failure = await Effect.runPromise(
      Effect.flip(
        fetchCalendar(config, '2026-07-17', '2026-07-17').pipe(
          Effect.provideService(HttpClient.HttpClient, failingClient),
        ),
      ),
    )
    expect(failure).toMatchObject({ _tag: 'PublicationError', phase: 'provider' })
    expect(failure.message).toContain('HTTP 429')
  })

  test('interrupts an in-flight provider request when its deadline expires', async () => {
    let interrupted = false
    const stalledClient = HttpClient.make(() =>
      Effect.never.pipe(
        Effect.onInterrupt(() =>
          Effect.sync(() => {
            interrupted = true
          }),
        ),
      ),
    )

    const failure = await Effect.runPromise(
      Effect.flip(
        fetchCalendar({ ...config, operationTimeoutMs: 10 }, '2026-07-17', '2026-07-17').pipe(
          Effect.provideService(HttpClient.HttpClient, stalledClient),
        ),
      ),
    )

    expect(failure).toMatchObject({ _tag: 'PublicationError', phase: 'provider' })
    expect(failure.message).toContain('timed out')
    expect(interrupted).toBe(true)
  })
})
