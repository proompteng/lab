import { describe, expect, test } from 'bun:test'
import { Result } from 'effect'

import { makeSnapshot } from '../test-fixtures'
import { decodeSnapshotReferenceRows, validateSnapshotReference, type SnapshotReferenceRow } from './snapshot-reference'

const manifest = makeSnapshot(800).manifest
const snapshot = manifest.finalizedSnapshot
const reference: SnapshotReferenceRow = {
  snapshot_id: snapshot.snapshotId,
  schema_version: snapshot.schemaVersion,
  database_name: manifest.database,
  table_name: manifest.tables.bars,
  dataset_version: snapshot.publicationSchemaVersion,
  source: snapshot.source,
  source_feed: snapshot.sourceFeed,
  adjustment: snapshot.adjustment,
  content_hash: snapshot.contentHash,
  row_count: snapshot.rowCount,
  first_session: snapshot.firstSession,
  last_session: snapshot.lastSession,
  manifest: snapshot,
}

describe('snapshot reference decisions', () => {
  test('accepts the exact immutable snapshot binding', () => {
    expect(validateSnapshotReference(manifest, [reference])).toEqual(Result.void)
  })

  test('fails closed with exact cardinality and content facts', () => {
    expect(validateSnapshotReference(manifest, [])).toMatchObject({
      _tag: 'Failure',
      failure: {
        _tag: 'SnapshotReferenceCardinalityMismatch',
        snapshotId: snapshot.snapshotId,
        observedCount: 0,
        expectedCount: 1,
      },
    })
    expect(validateSnapshotReference(manifest, [{ ...reference, content_hash: 'f'.repeat(64) }])).toMatchObject({
      _tag: 'Failure',
      failure: {
        _tag: 'SnapshotReferenceMismatch',
        path: ['contentHash'],
        observed: 'f'.repeat(64),
        expected: snapshot.contentHash,
      },
    })
  })

  test('decodes unknown SQL rows once at the adapter boundary', () => {
    expect(decodeSnapshotReferenceRows([reference])).toEqual(Result.succeed([reference]))
    expect(decodeSnapshotReferenceRows([{ ...reference, row_count: '800' }])).toMatchObject({
      _tag: 'Failure',
    })
  })
})
