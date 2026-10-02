import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, linkSync, rmSync, truncateSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHash } from 'node:crypto'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { inspectEvidence, readFileRange, summarizePostgresLog } from './diagnostic-files'

let directory: string
let root: string

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'agents-diagnostics-'))
  root = join(directory, 'workspace')
  mkdirSync(root)
})

afterEach(() => rmSync(directory, { recursive: true, force: true }))

describe('bounded workspace file reads', () => {
  it('pages a file with stable identity and an explicit end marker', () => {
    writeFileSync(join(root, 'sample.txt'), 'hello world')
    const first = readFileRange(root, { path: 'sample.txt', maxBytes: 5 })
    expect(first).toMatchObject({ content: 'hello', offset: 0, nextOffset: 5, endOfFile: false, sizeBytes: 11 })
    const second = readFileRange(root, {
      path: 'sample.txt',
      offset: first.nextOffset,
      expectedVersion: first.version,
      maxBytes: 6,
    })
    expect(second).toMatchObject({ content: ' world', nextOffset: 11, endOfFile: true, version: first.version })
  })

  it('does not split a UTF-8 character between pages', () => {
    writeFileSync(join(root, 'utf8.txt'), 'a😺b')
    const first = readFileRange(root, { path: 'utf8.txt', maxBytes: 4 })
    expect(first).toMatchObject({ content: 'a', nextOffset: 1 })
    expect(readFileRange(root, { path: 'utf8.txt', offset: 1, maxBytes: 4 })).toMatchObject({
      content: '😺',
      nextOffset: 5,
    })
    expect(() => readFileRange(root, { path: 'utf8.txt', offset: 2 })).toThrow(/UTF-8/)
    expect(() => readFileRange(root, { path: 'utf8.txt', offset: 1, maxBytes: 1 })).toThrow(/UTF-8/)
  })

  it('rejects changed files when resuming an evidence read', () => {
    const path = join(root, 'sample.txt')
    writeFileSync(path, 'first')
    const first = readFileRange(root, { path, maxBytes: 2 })
    writeFileSync(path, 'second')
    expect(() => readFileRange(root, { path, offset: 2, expectedVersion: first.version })).toThrow(/changed/)
  })

  it('rejects traversal, symlink escapes, hard links and non-files', () => {
    const outside = join(directory, 'private.txt')
    writeFileSync(outside, 'never return this')
    symlinkSync(outside, join(root, 'escape'))
    symlinkSync(directory, join(root, 'parent-escape'))
    linkSync(outside, join(root, 'hard-link'))
    for (const path of ['../private.txt', outside, 'escape', 'parent-escape/private.txt', 'hard-link', '.']) {
      expect(() => readFileRange(root, { path })).toThrow()
    }
  })

  it('permits a canonical symlink target that remains inside the workspace', () => {
    writeFileSync(join(root, 'real.txt'), 'permitted')
    symlinkSync(join(root, 'real.txt'), join(root, 'alias.txt'))
    expect(readFileRange(root, { path: 'alias.txt' }).content).toBe('permitted')
  })

  it('reads a bounded page from a large sparse file without loading the whole file', () => {
    const path = join(root, 'large.txt')
    writeFileSync(path, 'a')
    truncateSync(path, 256 * 1024 * 1024)
    expect(readFileRange(root, { path, maxBytes: 1 })).toMatchObject({ content: 'a', sizeBytes: 268435456 })
    expect(() => readFileRange(root, { path, maxBytes: 200001 })).toThrow(/maxBytes/)
    expect(() => readFileRange(root, { path, offset: -1 })).toThrow(/offset/)
  })

  it('rejects invalid UTF-8 instead of silently replacing evidence bytes', () => {
    writeFileSync(join(root, 'invalid.txt'), Buffer.from([0xff]))
    expect(() => readFileRange(root, { path: 'invalid.txt' })).toThrow(/UTF-8/)
  })
})

describe('evidence integrity inspection', () => {
  it('validates an entire NDJSON file and returns counts and its exact hash, never values', () => {
    const content = '{"kind":"synthetic","data":[{"token":"not-for-output"}]}\n\n[1,2]\nnull\n'
    const sha256 = createHash('sha256').update(content).digest('hex')
    writeFileSync(join(root, 'evidence.ndjson'), content)
    const result = inspectEvidence(root, { path: 'evidence.ndjson', format: 'ndjson', expectedSha256: sha256 })
    expect(result).toMatchObject({
      sha256,
      documentCount: 3,
      objectDocuments: 1,
      arrayDocuments: 1,
      scalarDocuments: 1,
      topLevelArrayElements: 2,
      blankLines: 1,
      completeFile: true,
    })
    expect(JSON.stringify(result)).not.toContain('not-for-output')
  })

  it('validates JSON scalars, empty collections, and hash mismatch', () => {
    writeFileSync(join(root, 'empty.json'), '[]')
    expect(inspectEvidence(root, { path: 'empty.json', format: 'json' })).toMatchObject({
      documentCount: 1,
      arrayDocuments: 1,
      topLevelArrayElements: 0,
    })
    expect(() => inspectEvidence(root, { path: 'empty.json', format: 'json', expectedSha256: '0'.repeat(64) })).toThrow(
      /hash/,
    )
  })

  it('validates whitespace-separated multiline JSON documents without treating them as NDJSON', () => {
    const content = [
      JSON.stringify({ synthetic: ['braces } {', 'quote " and \\'] }, null, 2),
      '[\n1,\n2\n]',
      'null',
    ].join('\n\n')
    writeFileSync(join(root, 'stream.json'), content)
    expect(inspectEvidence(root, { path: 'stream.json', format: 'json-stream' })).toMatchObject({
      format: 'json-stream',
      documentCount: 3,
      objectDocuments: 1,
      arrayDocuments: 1,
      scalarDocuments: 1,
      topLevelArrayElements: 2,
      completeFile: true,
      sha256: createHash('sha256').update(content).digest('hex'),
    })
    expect(() => inspectEvidence(root, { path: 'stream.json', format: 'ndjson' })).toThrow(/Invalid JSON/)
  })

  it('rejects malformed tails and missing document separators without returning partial success', () => {
    for (const content of ['{}\n{"truncated":', '{}{}', 'truefalse', '{}\n"unterminated', '  \n']) {
      writeFileSync(join(root, 'stream.json'), content)
      expect(() => inspectEvidence(root, { path: 'stream.json', format: 'json-stream' })).toThrow()
    }
  })

  it('accepts a complete bounded stream larger than 16 MiB', () => {
    writeFileSync(join(root, 'stream.json'), ' '.repeat(16 * 1024 * 1024) + '{}\n[]')
    expect(inspectEvidence(root, { path: 'stream.json', format: 'json-stream' })).toMatchObject({
      documentCount: 2,
      objectDocuments: 1,
      arrayDocuments: 1,
      completeFile: true,
    })
  })

  it('does not return partial success or parser excerpts for malformed, empty or oversized input', () => {
    writeFileSync(join(root, 'invalid.ndjson'), '{}\n{"secret":not-for-output}\n')
    expect(() => inspectEvidence(root, { path: 'invalid.ndjson', format: 'ndjson' })).toThrow('Invalid JSON at line 2')
    writeFileSync(join(root, 'empty.ndjson'), '\n')
    expect(() => inspectEvidence(root, { path: 'empty.ndjson', format: 'ndjson' })).toThrow(/empty/)
    writeFileSync(join(root, 'large.json'), '')
    truncateSync(join(root, 'large.json'), 64 * 1024 * 1024 + 1)
    expect(() => inspectEvidence(root, { path: 'large.json', format: 'json' })).toThrow(/limit/)
  })
})

describe('PostgreSQL retained-log summaries', () => {
  const startAt = '2026-01-02T13:30:00Z'
  const endAt = '2026-01-02T20:00:00Z'
  const record = (time: string, message: string, severity = 'LOG') =>
    JSON.stringify({ level: 'info', ts: time, record: { log_time: time, error_severity: severity, message } })

  it('aggregates only in-range observations and never returns SQL or raw messages', () => {
    const content =
      [
        record('2026-01-02T13:29:59Z', 'duration: 999 ms  statement: COMMIT'),
        record('2026-01-02T13:30:00Z', 'duration: 10 ms  statement: COMMIT'),
        `2026-01-02T14:00:00Z ${record('2026-01-02T14:00:00Z', 'duration: 2000 ms  statement: COMMIT')}`,
        record('2026-01-02T14:01:00Z', 'duration: 4000 ms  statement: SELECT private_value FROM private_table'),
        record(
          '2026-01-02T15:00:00Z',
          'checkpoint complete: wrote 2 buffers; write=0.001 s, sync=2.500 s, total=2.501 s; sync files=2, longest=2.000 s, average=1.250 s',
        ),
        record(
          '2026-01-02T15:01:00Z',
          'restartpoint complete: wrote 2 buffers; write=0.001 s, sync=3.000 s, total=3.001 s',
        ),
        record('2026-01-02T16:00:00Z', 'terminating walsender process due to replication timeout', 'ERROR'),
        record('2026-01-02T20:00:00Z', 'duration: 999 ms  statement: COMMIT'),
        '{bad-json}',
        JSON.stringify({ record: { message: 'duration: 123 ms  statement: COMMIT' } }),
      ].join('\n') + '\n'
    writeFileSync(join(root, 'postgres.log'), content)
    const result = summarizePostgresLog(root, { path: 'postgres.log', startAt, endAt })
    expect(result).toMatchObject({
      completeFile: true,
      sessionCoverage: 'not_proven',
      inRangeRecords: 6,
      outOfRangeRecords: 2,
      malformedLines: 1,
      recordsWithoutTimestamp: 1,
      replicationTimeouts: 1,
      slowCommitsOverOneSecond: 1,
      commitDurationMs: { count: 2, minimum: 10, maximum: 2000, p95: 2000 },
      statementDurationMs: { count: 3, minimum: 10, maximum: 4000, p95: 4000 },
      checkpointSyncMs: { count: 1, maximum: 2500 },
      restartpointSyncMs: { count: 1, maximum: 3000 },
    })
    expect(result.sha256).toBe(createHash('sha256').update(content).digest('hex'))
    expect(JSON.stringify(result)).not.toContain('private_value')
    expect(JSON.stringify(result)).not.toContain('private_table')
  })

  it('keeps no observed duration distinct from zero duration', () => {
    writeFileSync(join(root, 'quiet.log'), record('2026-01-02T14:00:00Z', 'database system is ready'))
    const result = summarizePostgresLog(root, { path: 'quiet.log', startAt, endAt })
    expect(result.commitDurationMs).toEqual({
      count: 0,
      minimum: null,
      maximum: null,
      p50: null,
      p95: null,
      total: null,
    })
    expect(result.sessionCoverage).toBe('not_proven')
  })

  it('accepts PostgreSQL UTC log timestamps and excludes undated events', () => {
    writeFileSync(
      join(root, 'postgres.log'),
      record('2026-01-02 14:00:00.125 UTC', 'duration: 0 ms  statement: COMMIT'),
    )
    const result = summarizePostgresLog(root, { path: 'postgres.log', startAt, endAt })
    expect(result).toMatchObject({
      firstObservedAt: '2026-01-02T14:00:00.125Z',
      commitDurationMs: { count: 1, total: 0 },
    })
  })

  it('does not substitute collection time for an invalid PostgreSQL event timestamp', () => {
    writeFileSync(
      join(root, 'postgres.log'),
      JSON.stringify({
        ts: '2026-01-02T14:00:00Z',
        record: { log_time: '2026-02-30T14:00:00Z', message: 'duration: 2000 ms  statement: COMMIT' },
      }),
    )
    const result = summarizePostgresLog(root, { path: 'postgres.log', startAt, endAt })
    expect(result).toMatchObject({ recordsWithoutTimestamp: 1, inRangeRecords: 0, commitDurationMs: { count: 0 } })
  })

  it('does not classify embedded COMMIT text or multiple statements as a measured COMMIT', () => {
    writeFileSync(
      join(root, 'postgres.log'),
      [
        record('2026-01-02T14:00:00Z', "duration: 2000 ms  statement: SELECT 'statement: COMMIT'"),
        record('2026-01-02T14:01:00Z', 'duration: 2000 ms  statement: COMMIT; SELECT 1'),
        record('2026-01-02T14:02:00Z', 'duration: 10 ms  execute S_1: COMMIT;'),
      ].join('\n'),
    )
    const result = summarizePostgresLog(root, { path: 'postgres.log', startAt, endAt })
    expect(result).toMatchObject({ statementDurationMs: { count: 3 }, commitDurationMs: { count: 1, total: 10 } })
  })

  it('enforces line and record limits instead of silently truncating a summary', () => {
    writeFileSync(join(root, 'long.log'), 'x'.repeat(1024 * 1024 + 1))
    expect(() => summarizePostgresLog(root, { path: 'long.log', startAt, endAt })).toThrow(/line limit/)
    writeFileSync(join(root, 'many.log'), '\n'.repeat(250_001))
    expect(() => summarizePostgresLog(root, { path: 'many.log', startAt, endAt })).toThrow(/line diagnostic limit/)
  })

  it('rejects unbounded or reversed intervals and does not accept code or SQL arguments', () => {
    writeFileSync(join(root, 'postgres.log'), '')
    expect(() => summarizePostgresLog(root, { path: 'postgres.log', startAt: endAt, endAt: startAt })).toThrow(
      /interval/,
    )
    expect(() => summarizePostgresLog(root, { path: 'postgres.log', startAt, endAt: '2026-01-05T20:00:00Z' })).toThrow(
      /24/,
    )
    expect(() => summarizePostgresLog(root, { path: 'postgres.log', startAt: 'yesterday', endAt })).toThrow(/timestamp/)
  })
})
