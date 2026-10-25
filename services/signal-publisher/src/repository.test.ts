import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { createServer } from 'node:http'

import { ClickhouseClient } from '@effect/sql-clickhouse'
import { Effect, Schema } from 'effect'

import { IsoDateSchema } from './domain'
import { insertBatchSize, makeSnapshotRepository, partitionInsertRows } from './repository'

describe('ClickHouse readback contract', () => {
  test.each([1_000, 180_000])(
    'keeps insert quorum and server deadlines inside the %i ms client budget',
    async (budget) => {
      const requests: Array<{ readonly url: URL; readonly body: string }> = []
      const server = createServer(async (request, response) => {
        let body = ''
        for await (const chunk of request) body += String(chunk)
        requests.push({ url: new URL(request.url ?? '/', 'http://fixture'), body })
        response.writeHead(200)
        response.end()
      })
      await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
      try {
        const address = server.address()
        if (address === null || typeof address === 'string') throw new Error('HTTP fixture has no TCP address')
        await Effect.runPromise(
          Effect.gen(function* () {
            const repository = yield* makeSnapshotRepository(budget)
            yield* repository.insertSessions('a'.repeat(64), [
              {
                snapshot_id: 'a'.repeat(64),
                calendar_version: 'fixture',
                session_date: Schema.decodeUnknownSync(IsoDateSchema)('2026-10-12'),
                open_time: '09:30',
                close_time: '16:00',
                timezone: 'America/New_York',
                provider: 'alpaca',
              },
            ])
          }).pipe(
            Effect.provide(
              ClickhouseClient.layer({ url: `http://127.0.0.1:${address.port}`, request_timeout: budget }),
            ),
          ),
        )
        const inserted = requests.find((request) => request.url.searchParams.get('query')?.startsWith('INSERT INTO'))
        if (inserted === undefined) throw new Error('ClickHouse driver did not send an insert')
        const requestUrl = inserted.url
        expect(JSON.parse(inserted.body).snapshot_id).toBe('a'.repeat(64))
        const quorum = Number(requestUrl.searchParams.get('insert_quorum_timeout'))
        const execution = Number(requestUrl.searchParams.get('max_execution_time')) * 1_000
        expect(quorum).toBeGreaterThan(0)
        expect(execution).toBeGreaterThan(quorum)
        expect(execution).toBeLessThan(budget)
        expect(requestUrl.searchParams.get('insert_quorum')).toBe('2')
        expect(requestUrl.searchParams.get('insert_quorum_parallel')).toBe('0')
        expect(requestUrl.searchParams.get('insert_deduplicate')).toBe('1')
        expect(requestUrl.searchParams.get('log_profile_events')).toBe('1')
        if (budget === 180_000) expect(quorum).toBeGreaterThan(60_000)
      } finally {
        const closed = new Promise<void>((resolve) => server.close(() => resolve()))
        server.closeAllConnections()
        await closed
      }
    },
  )

  test('preserves the Decimal64 scale used by snapshot content hashes', () => {
    const source = readFileSync(import.meta.dir + '/repository.ts', 'utf8')

    for (const column of ['adjusted_open', 'adjusted_high', 'adjusted_low', 'adjusted_close', 'adjusted_volume']) {
      expect(source).toContain(`toDecimalString(${column}, 8) AS ${column}`)
    }
    expect(source).toContain('toDecimalString(vwap, 8)')
    expect(source).not.toMatch(/toString\(adjusted_(?:open|high|low|close|volume)\)/)
  })

  test('bounds quorum inserts without dropping or reordering rows', () => {
    const rows = Array.from({ length: insertBatchSize * 2 + 17 }, (_, index) => ({ session_date: '2026-10-12', index }))
    const batches = partitionInsertRows(rows)

    expect(batches.map((batch) => batch.length)).toEqual([insertBatchSize, insertBatchSize, 17])
    expect(batches.flat()).toEqual(rows)
    expect(partitionInsertRows([])).toEqual([])
  })
  test('one quorum insert touches one yearly partition even when source rows are symbol ordered', () => {
    const rows = [
      { symbol: 'AAPL', session_date: '2025-12-31' },
      { symbol: 'AAPL', session_date: '2026-01-02' },
      { symbol: 'MSFT', session_date: '2025-12-31' },
      { symbol: 'MSFT', session_date: '2026-01-02' },
    ]
    const batches = partitionInsertRows(rows)
    expect(batches).toEqual([
      [rows[0], rows[2]],
      [rows[1], rows[3]],
    ])
    expect(batches.map((batch) => new Set(batch.map((row) => row.session_date.slice(0, 4))).size)).toEqual([1, 1])
    expect(batches.flat().sort((a, b) => rows.indexOf(a) - rows.indexOf(b))).toEqual(rows)
    expect(partitionInsertRows([...rows].reverse()).map((batch) => batch[0]?.session_date.slice(0, 4))).toEqual([
      '2025',
      '2026',
    ])
  })
})
