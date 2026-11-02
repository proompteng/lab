import { expect, test } from 'bun:test'
import { Result } from 'effect'

import { sha256, canonicalHashV1Result } from '../hash'
import { decodeEquityEdgeInput, decodeEquityEdgeSource, EquityHistoricalFeed } from './equity-edge-source'

const barsUrl = (end = '2026-08-19') =>
  'https://data.alpaca.markets/v2/stocks/bars?' +
  new URLSearchParams({
    symbols: 'SPY,AAPL',
    timeframe: '1Min',
    start: '2026-08-03T00:00:00Z',
    end: end + 'T23:59:59Z',
    feed: 'iex',
    adjustment: 'raw',
    sort: 'asc',
    limit: '10000',
    asof: end,
  }).toString()
const continuedPage = (page: string) =>
  page
    .replace('"page":0', '"page":1')
    .replace('"requestPageToken":null', '"requestPageToken":"next"')
    .replace('asof=2026-08-19', 'asof=2026-08-19&page_token=next')

const fixture = () => {
  const calendar = Array.from({ length: 17 }, (_, i) => ({
    date: `2026-08-${String(i + 3).padStart(2, '0')}`,
    open: '09:30',
    close: '16:00',
    session_open: '0400',
    session_close: '2000',
  }))
  const at = '2026-10-17T06:24:39.700Z'
  const material = [
    {
      kind: 'calendar',
      requestUrl: 'https://paper-api.alpaca.markets/v2/calendar?start=2026-08-03&end=2026-08-19',
      observedAt: at,
      data: calendar,
    },
    {
      kind: 'bars',
      page: 0,
      requestUrl: barsUrl(),
      requestPageToken: null,
      observedAt: at,
      data: {
        bars: { SPY: [{ t: '2026-08-03T13:30:00Z', o: 100, h: 101, l: 99, c: 100, v: 10, vw: 100 }] },
        next_page_token: null,
      },
    },
    { kind: 'complete', pages: 1, bars: 1, feed: 'iex', adjustment: 'raw', observedAt: at },
  ]
  const text = material.map((row) => JSON.stringify(row)).join('\n') + '\n'
  const input = {
    schemaVersion: 'bayn.equity-edge-screen-input.v2',
    sourceSha256: sha256(text),
    calendar: {
      start: '2026-08-03',
      end: '2026-08-19',
      expectedHash: Result.getOrThrow(canonicalHashV1Result(calendar)),
    },
    symbols: ['SPY', 'AAPL'],
    development: { start: '2026-08-17', end: '2026-08-17' },
    validation: { start: '2026-08-18', end: '2026-08-18' },
    holdout: { start: '2026-08-19', end: '2026-08-19' },
  }
  return { text, input }
}

const decode = (text: string, input: unknown) =>
  decodeEquityEdgeInput(input).pipe(Result.flatMap((value) => decodeEquityEdgeSource(text, value)))

test('source preserves regular exchange hours, byte identity, explicit holes and separate partitions', () => {
  const { text, input } = fixture()
  const result = decode(text, input)
  if (Result.isFailure(result)) throw result.failure
  expect(result.success.days[0]?.openAt).toBe(Date.parse('2026-08-03T13:30:00Z'))
  expect(result.success.days[0]?.closeAt).toBe(Date.parse('2026-08-03T20:00:00Z'))
  expect(result.success.source.bars).toBe(1)
  expect(result.success.coverage[0]?.symbols).toEqual([
    { symbol: 'SPY', expected: 390, observed: 1, missing: 389 },
    { symbol: 'AAPL', expected: 390, observed: 0, missing: 390 },
  ])
  expect(result.success.source.originalArrivalTiming).toBe('UNKNOWN')
})

test('changed source bytes fail even when JSON meaning is unchanged', () => {
  const { text, input } = fixture()
  expect(Result.isFailure(decode(text + '\n', input))).toBe(true)
})

test('an omitted interior trading session cannot remain a complete calendar', () => {
  const { text, input } = fixture()
  const lines = text.trimEnd().split('\n')
  const header = JSON.parse(lines[0] ?? '')
  const template = header.data[0]
  header.data.push({ ...template, date: '2026-08-20' }, { ...template, date: '2026-08-21' })

  header.requestUrl = header.requestUrl.replace('end=2026-08-19', 'end=2026-08-21')
  const remainder = lines.slice(1).map((line) => line.replace(barsUrl(), barsUrl('2026-08-21')))
  const full = [JSON.stringify(header), ...remainder].join('\n') + '\n'
  const scope = {
    ...input,
    calendar: {
      ...input.calendar,
      end: '2026-08-21',
      expectedHash: Result.getOrThrow(canonicalHashV1Result(header.data)),
    },
    development: { start: '2026-08-17', end: '2026-08-19' },
    validation: { start: '2026-08-20', end: '2026-08-20' },
    holdout: { start: '2026-08-21', end: '2026-08-21' },
  }
  expect(Result.isSuccess(decode(full, { ...scope, sourceSha256: sha256(full) }))).toBe(true)
  header.data = header.data.filter((day: { date: string }) => day.date !== '2026-08-18')
  const omitted = [JSON.stringify(header), ...remainder].join('\n') + '\n'
  expect(Result.isFailure(decode(omitted, { ...scope, sourceSha256: sha256(omitted) }))).toBe(true)
})

test.each([
  ['calendar request', 'end=2026-08-19', 'end=2026-08-18'],
  ['feed query', 'feed=iex', 'feed=sip'],
  ['timeframe query', 'timeframe=1Min', 'timeframe=5Min'],
  ['mapping query', 'asof=2026-08-19', 'asof=2026-08-18'],
  ['duplicate query', 'sort=asc', 'sort=asc&sort=desc'],
  ['outside query range', '2026-08-03T13:30:00Z', '2026-08-02T13:30:00Z'],
] as const)('rejects changed %s despite a new source byte pin', (_name, before, after) => {
  const { text, input } = fixture()
  const changed = text.replace(before, after)
  expect(Result.isFailure(decode(changed, { ...input, sourceSha256: sha256(changed) }))).toBe(true)
})

test('requires the independent calendar inventory and rejects weaker version-one inputs', () => {
  const { text, input } = fixture()
  expect(
    Result.isFailure(decode(text, { ...input, calendar: { ...input.calendar, expectedHash: '0'.repeat(64) } })),
  ).toBe(true)
  expect(Result.isFailure(decode(text, { ...input, schemaVersion: 'bayn.equity-edge-screen-input.v1' }))).toBe(true)
})

test.each(['missing', 'initial', 'spliced'] as const)('rejects %s request-token evidence', (failure) => {
  const { text, input } = fixture()
  let changed = text
  if (failure === 'missing') changed = text.replace('"requestPageToken":null,', '')
  if (failure === 'initial') changed = text.replace('"requestPageToken":null', '"requestPageToken":"unexpected"')
  if (failure === 'spliced') {
    const [header, page, end] = text.trimEnd().split('\n')
    if (header === undefined || page === undefined || end === undefined) throw new Error('fixture incomplete')
    changed =
      [
        header,
        page.replace('"next_page_token":null', '"next_page_token":"next"'),
        continuedPage(page)
          .replace('13:30', '13:31')
          .replace('"requestPageToken":"next"', '"requestPageToken":"other-chain"'),
        end.replace('"pages":1', '"pages":2').replace('"bars":1', '"bars":2'),
      ].join('\n') + '\n'
  }
  expect(Result.isFailure(decode(changed, { ...input, sourceSha256: sha256(changed) }))).toBe(true)
})

test('accepts an explicitly witnessed continuation-token chain', () => {
  const { text, input } = fixture()
  const [header, page, end] = text.trimEnd().split('\n')
  if (header === undefined || page === undefined || end === undefined) throw new Error('fixture incomplete')
  const changed =
    [
      header,
      page.replace('"next_page_token":null', '"next_page_token":"next"'),
      continuedPage(page).replace('13:30', '13:31'),
      end.replace('"pages":1', '"pages":2').replace('"bars":1', '"bars":2'),
    ].join('\n') + '\n'
  const result = decode(changed, { ...input, sourceSha256: sha256(changed) })
  if (Result.isFailure(result)) throw result.failure
  expect(result.success.source.bars).toBe(2)
})

test.each(['2026-02-30T14:30:00Z', '2026-02-29T14:30:00.000000000Z', '2026-08-03T24:00:00Z'])(
  'rejects normalized impossible source instant %s',
  (timestamp) => {
    const { text, input } = fixture()
    const changed = text.replace('2026-08-03T13:30:00Z', timestamp)
    expect(Result.isFailure(decode(changed, { ...input, sourceSha256: sha256(changed) }))).toBe(true)
  },
)

test.each(['within one page', 'across pages'] as const)('rejects per-symbol time regression %s', (location) => {
  const { text, input } = fixture()
  const lines = text.trimEnd().split('\n')
  const header = lines[0],
    page = lines[1],
    end = lines[2]
  if (header === undefined || page === undefined || end === undefined) throw new Error('fixture incomplete')
  let changed: string
  if (location === 'within one page') {
    const row = '{"t":"2026-08-03T13:30:00Z","o":100,"h":101,"l":99,"c":100,"v":10,"vw":100}'
    changed =
      [header, page.replace(row, `${row.replace('13:30', '13:31')},${row}`), end.replace('"bars":1', '"bars":2')].join(
        '\n',
      ) + '\n'
  } else {
    changed =
      [
        header,
        page.replace('13:30', '13:31').replace('"next_page_token":null', '"next_page_token":"next"'),
        continuedPage(page),
        end.replace('"pages":1', '"pages":2').replace('"bars":1', '"bars":2'),
      ].join('\n') + '\n'
  }
  expect(Result.isFailure(decode(changed, { ...input, sourceSha256: sha256(changed) }))).toBe(true)
})

test('historical consolidated data requires an explicitly bound feed; it cannot replace IEX silently', () => {
  const { text, input } = fixture()
  const sip = text.replace('"feed":"iex"', '"feed":"sip"').replace('feed=iex', 'feed=sip')
  expect(Result.isFailure(decode(sip, { ...input, sourceSha256: sha256(sip) }))).toBe(true)
  const result = decode(sip, { ...input, feed: 'sip', sourceSha256: sha256(sip) })
  if (Result.isFailure(result)) throw result.failure
  expect(result.success.source.feed).toBe(EquityHistoricalFeed.Sip)
  expect(result.success.source.originalArrivalTiming).toBe('UNKNOWN')
})

test.each(['missing terminator', 'wrong page count', 'foreign feed', 'repeated cursor', 'duplicate bar'] as const)(
  'rejects %s after rehashing',
  (failure) => {
    const { text, input } = fixture()
    let changed = text
    if (failure === 'missing terminator') changed = text.trimEnd().split('\n').slice(0, -1).join('\n')
    if (failure === 'wrong page count') changed = text.replace('"pages":1', '"pages":2')
    if (failure === 'foreign feed') changed = text.replace('"feed":"iex"', '"feed":"sip"')
    if (failure === 'repeated cursor')
      changed = text.replace('"next_page_token":null', '"next_page_token":"nonterminal"')
    if (failure === 'duplicate bar') {
      const row = '{"t":"2026-08-03T13:30:00Z","o":100,"h":101,"l":99,"c":100,"v":10,"vw":100}'
      changed = text.replace(row, `${row},${row}`).replace('"bars":1', '"bars":2')
    }
    expect(Result.isFailure(decode(changed, { ...input, sourceSha256: sha256(changed) }))).toBe(true)
  },
)

test('forbids temporal overlap, unknown request fields, missing warmup and a missing benchmark', () => {
  const { text, input } = fixture()
  expect(Result.isFailure(decode(text, { ...input, validation: input.development }))).toBe(true)
  expect(Result.isFailure(decode(text, { ...input, allowTrading: true }))).toBe(true)
  expect(Result.isFailure(decode(text, { ...input, development: { start: '2026-08-16', end: '2026-08-17' } }))).toBe(
    true,
  )
  expect(Result.isFailure(decode(text, { ...input, symbols: ['AAPL'] }))).toBe(true)
})
