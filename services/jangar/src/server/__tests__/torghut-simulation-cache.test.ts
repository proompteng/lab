import { describe, expect, it } from 'vitest'

import { buildDatasetCacheArtifactPaths, resolveDurableDatasetCacheRow } from '../torghut-simulation-cache'

describe('torghut simulation cache helpers', () => {
  it('accepts only cache rows with durable S3 artifacts', () => {
    const durable = {
      artifact_path: ' s3://torghut-simulations/cache/source.jsonl.zst ',
      chunk_manifest_path: 's3://torghut-simulations/cache/source.jsonl.zst.manifest.json',
    }

    expect(resolveDurableDatasetCacheRow(durable)).toBe(durable)
    expect(resolveDurableDatasetCacheRow({ ...durable, artifact_path: '/tmp/source.jsonl.zst' })).toBeNull()
    expect(resolveDurableDatasetCacheRow({ ...durable, chunk_manifest_path: null })).toBeNull()
  })

  it('builds cache artifact paths for supported dump formats', () => {
    const paths = buildDatasetCacheArtifactPaths('cache-key', 'jsonl.zst')

    expect(paths.artifactPath).toMatch(/^s3:\/\/[^/]+\/.+\/cache-key\/source-dump\.jsonl\.zst$/)
    expect(paths.chunkManifestPath).toBe(`${paths.artifactPath}.manifest.json`)
  })
})
