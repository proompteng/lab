import { IntradayIngestionDelayDirection, IntradaySnapshotFailure } from './model'

const archiveNotMaterializedMessage = 'intraday archive has not materialized the captured source offset'

export const isIntradaySnapshotPending = (cause: unknown): cause is IntradaySnapshotFailure =>
  cause instanceof IntradaySnapshotFailure &&
  (cause.reason === 'not-ready' ||
    (cause.reason === 'watermark' && cause.message === archiveNotMaterializedMessage) ||
    (cause.reason === 'freshness' && cause.ingestionDelayDirection === IntradayIngestionDelayDirection.AboveMaximum))
