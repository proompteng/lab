import { expect, test } from 'bun:test'
import { Effect } from 'effect'

import { LogEntry, makeLogger } from '../../src/observability/logger'

test('logger honors level filters and carries fields', async () => {
  const entries: LogEntry[] = []
  const sink = {
    write(entry: LogEntry) {
      entries.push(entry)
    },
  }
  const logger = makeLogger({ level: 'warn', format: 'json', sink })

  await Effect.runPromise(logger.log('info', 'no-op'))
  await Effect.runPromise(logger.log('warn', 'warned', { detail: true }))

  expect(entries.length).toBe(1)
  expect(entries[0]).toMatchObject({ level: 'warn', message: 'warned', fields: { detail: true } })
})
