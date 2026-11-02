import { posix as pathPosix } from 'node:path'

import { resolveTorghutSimulationStorageConfig } from './torghut-config'

type DatasetCacheArtifactRow = {
  artifact_path?: unknown
  chunk_manifest_path?: unknown
}

const simulationStorageConfig = resolveTorghutSimulationStorageConfig(process.env)

const asNonEmptyString = (value: unknown) => {
  if (typeof value !== 'string') return null
  const trimmed = value.trim()
  return trimmed.length > 0 ? trimmed : null
}

const dumpSuffixForFormat = (dumpFormat: string) =>
  dumpFormat === 'jsonl.gz' ? '.jsonl.gz' : dumpFormat === 'jsonl.zst' ? '.jsonl.zst' : '.ndjson'

export const buildDatasetCacheArtifactPaths = (cacheKey: string, dumpFormat: string) => {
  const objectKey = pathPosix.join(
    simulationStorageConfig.cachePrefix,
    cacheKey,
    `source-dump${dumpSuffixForFormat(dumpFormat)}`,
  )
  return {
    artifactPath: `s3://${simulationStorageConfig.cacheBucket}/${objectKey}`,
    chunkManifestPath: `s3://${simulationStorageConfig.cacheBucket}/${objectKey}.manifest.json`,
  }
}

export const resolveDurableDatasetCacheRow = <T extends DatasetCacheArtifactRow>(row: T | null | undefined): T | null =>
  row &&
  asNonEmptyString(row.artifact_path)?.startsWith('s3://') &&
  asNonEmptyString(row.chunk_manifest_path)?.startsWith('s3://')
    ? row
    : null
