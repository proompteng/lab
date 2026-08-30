import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'

import { insertBatchSize, partitionInsertRows } from './repository'

describe('ClickHouse readback contract', () => {
  test('preserves the Decimal64 scale used by snapshot content hashes', () => {
    const source = readFileSync(import.meta.dir + '/repository.ts', 'utf8')

    for (const column of ['adjusted_open', 'adjusted_high', 'adjusted_low', 'adjusted_close', 'adjusted_volume']) {
      expect(source).toContain(`toDecimalString(${column}, 8) AS ${column}`)
    }
    expect(source).toContain('toDecimalString(vwap, 8)')
    expect(source).not.toMatch(/toString\(adjusted_(?:open|high|low|close|volume)\)/)
  })

  test('bounds quorum inserts without dropping or reordering rows', () => {
    const rows = Array.from({ length: insertBatchSize * 2 + 17 }, (_, index) => index)
    const batches = partitionInsertRows(rows)

    expect(batches.map((batch) => batch.length)).toEqual([insertBatchSize, insertBatchSize, 17])
    expect(batches.flat()).toEqual(rows)
    expect(partitionInsertRows([])).toEqual([])
  })
})
