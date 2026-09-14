import { ConfigProvider, Effect } from 'effect'
import { HttpClient, HttpClientResponse } from 'effect/unstable/http'

export const historyFixtureRequest = {
  schemaVersion: 'bayn.alpaca-backfill.v1',
  startDate: '2026-09-10',
  endDate: '2026-09-11',
  symbols: ['AAPL', 'SPY'],
  executionSessions: ['2026-09-10', '2026-09-11'],
}
export const historyFixtureCredentials = ConfigProvider.fromUnknown({
  BAYN_ALPACA_KEY_ID: 'fixture-key',
  BAYN_ALPACA_SECRET_KEY: 'fixture-secret',
})
export const historyFixtureHttp = HttpClient.make((request) => {
  const url = new URL(request.url)
  for (const [key, value] of request.urlParams) url.searchParams.set(key, value)
  const symbols = (url.searchParams.get('symbols') ?? '').split(',')
  const date = (url.searchParams.get('start') ?? '2026-09-11').slice(0, 10)
  const times = Array.from({ length: 35 }, (_, index) =>
    new Date(Date.parse(`${date}T13:30:00Z`) + index * 60_000).toISOString(),
  )
  const response = url.pathname.endsWith('/calendar')
    ? ['2026-09-10', '2026-09-11'].map((date) => ({
        date,
        open: '09:30',
        close: '10:05',
        session_open: '0400',
        session_close: '2000',
        settlement_date: '2026-09-14',
      }))
    : url.pathname.endsWith('/bars')
      ? {
          bars: Object.fromEntries(
            symbols.map((symbol) => [
              symbol,
              times.map((t, i) => ({
                t,
                o: 100 + i / 10,
                h: 101 + i / 10,
                l: 99 + i / 10,
                c: 100.5 + i / 10,
                v: 100,
                n: 10,
                vw: 100 + i / 10,
              })),
            ]),
          ),
          next_page_token: null,
        }
      : url.pathname.endsWith('/quotes')
        ? {
            quotes: Object.fromEntries(
              symbols.map((symbol) => [
                symbol,
                times.map((t) => ({ t, bp: 100, bs: 10, ap: 100.1, as: 20, bx: 'V', ax: 'V', c: ['R'], z: 'C' })),
              ]),
            ),
            next_page_token: null,
          }
        : {
            trades: Object.fromEntries(
              symbols.map((symbol) => [
                symbol,
                times.map((t, i) => ({ t, p: 100, s: 10, i, x: 'V', c: [' '], z: 'C' })),
              ]),
            ),
            next_page_token: null,
          }
  return Effect.succeed(HttpClientResponse.fromWeb(request, new Response(JSON.stringify(response), { status: 200 })))
})
