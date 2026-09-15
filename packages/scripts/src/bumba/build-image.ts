#!/usr/bin/env bun

import { execGit } from '../shared/git'
import { buildAndPushNixImage } from '../shared/nix-oci-deploy'

export type BuildImageOptions = {
  registry?: string
  repository?: string
  tag?: string
  context?: string
  dockerfile?: string
  version?: string
  commit?: string
  cacheRef?: string
  dryRun?: boolean
}

const resolveBuildArgs = (version: string, commit: string) => ({
  BUMBA_VERSION: version,
  BUMBA_COMMIT: commit,
  LAB_GIT_SHA: commit,
})

export const buildImage = async (options: BuildImageOptions = {}) => {
  const registry = options.registry ?? process.env.BUMBA_IMAGE_REGISTRY ?? 'registry.ide-newton.ts.net'
  const repository = options.repository ?? process.env.BUMBA_IMAGE_REPOSITORY ?? 'lab/bumba'
  const tag = options.tag ?? process.env.BUMBA_IMAGE_TAG ?? execGit(['rev-parse', '--short', 'HEAD'])
  const version = options.version ?? process.env.BUMBA_VERSION ?? execGit(['describe', '--tags', '--always'])
  const commit = options.commit ?? process.env.BUMBA_COMMIT ?? execGit(['rev-parse', 'HEAD'])

  const result = await buildAndPushNixImage({
    service: 'bumba',
    imageName: 'bumba',
    packageAttr: 'bumba-image',
    registry,
    repository,
    tag,
    sourceSha: commit,
    latestTag: 'latest',
    dryRun: options.dryRun,
  })

  return { image: `${registry}/${repository}:${tag}`, digest: result.reference, version, commit }
}

if (import.meta.main) {
  buildImage().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error))
    process.exit(1)
  })
}

export const __private = {
  execGit,
  resolveBuildArgs,
}
