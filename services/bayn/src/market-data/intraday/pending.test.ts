import { expect, test } from 'bun:test'

import { IntradayIngestionDelayDirection, IntradaySnapshotFailure } from './model'
import { isIntradaySnapshotPending } from './pending'

const archiveNotMaterializedMessage = 'intraday archive has not materialized the captured source offset'

test('recognizes only explicitly retryable intraday snapshot failures', () => {
  expect(
    isIntradaySnapshotPending(
      new IntradaySnapshotFailure({ reason: 'not-ready', message: 'quote is not materialized' }),
    ),
  ).toBe(true)
  expect(
    isIntradaySnapshotPending(
      new IntradaySnapshotFailure({ reason: 'watermark', message: archiveNotMaterializedMessage }),
    ),
  ).toBe(true)
  expect(
    isIntradaySnapshotPending(
      new IntradaySnapshotFailure({
        reason: 'freshness',
        message: 'intraday evidence does not match its declared feed delay',
        ingestionDelayDirection: IntradayIngestionDelayDirection.AboveMaximum,
      }),
    ),
  ).toBe(true)
  expect(
    isIntradaySnapshotPending(
      new IntradaySnapshotFailure({
        reason: 'freshness',
        message: 'intraday evidence does not match its declared feed delay',
        ingestionDelayDirection: IntradayIngestionDelayDirection.BelowMinimum,
      }),
    ),
  ).toBe(false)
  expect(
    isIntradaySnapshotPending(
      new IntradaySnapshotFailure({
        reason: 'freshness',
        message: 'intraday evidence does not match its declared feed delay',
      }),
    ),
  ).toBe(false)
  expect(
    isIntradaySnapshotPending(new IntradaySnapshotFailure({ reason: 'watermark', message: 'topology changed' })),
  ).toBe(false)
  expect(isIntradaySnapshotPending({ reason: 'not-ready', message: 'not a tagged failure' })).toBe(false)
})
