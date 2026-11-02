import { readFile } from 'node:fs/promises'

import {
  normalizeArtifactKey,
  putS3Object,
  resolveArtifactUploadConfig,
  type ArtifactUploadOptions,
} from '../artifact-storage'
import type { AgentProviderOutputArtifact } from './spec'

const normalizeNonEmpty = (value: string | undefined | null) => value?.trim() || null

export const uploadOutputArtifacts = async (
  artifacts: AgentProviderOutputArtifact[],
  options: ArtifactUploadOptions = {},
): Promise<AgentProviderOutputArtifact[]> => {
  if (artifacts.length === 0) return []
  const keyed = artifacts.filter((artifact) => normalizeNonEmpty(artifact.key))
  if (keyed.length === 0) return artifacts

  const config = resolveArtifactUploadConfig(options.env)
  if (!config) {
    throw new Error('artifact upload is required for keyed outputArtifacts but no artifact storage config is set')
  }

  const fetchImpl = options.fetch ?? fetch
  const now = options.now ?? (() => new Date())
  const uploaded: AgentProviderOutputArtifact[] = []
  for (const artifact of artifacts) {
    const key = normalizeNonEmpty(artifact.key)
    if (!key) {
      uploaded.push(artifact)
      continue
    }
    const path = normalizeNonEmpty(artifact.path)
    if (!path) {
      throw new Error(`outputArtifact ${artifact.name} declares key ${key} but no path`)
    }
    const body = await readFile(path)
    await putS3Object({ config, key, body, fetch: fetchImpl, now: now() })
    uploaded.push({
      ...artifact,
      key: normalizeArtifactKey(key),
      url: `s3://${config.bucket}/${normalizeArtifactKey(key)}`,
    })
  }
  return uploaded
}
