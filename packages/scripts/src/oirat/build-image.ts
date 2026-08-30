#!/usr/bin/env bun

import { buildAndPushNixImage } from '../shared/nix-oci-deploy'
import { execGit } from '../shared/git'

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

export const buildImage = async (options: BuildImageOptions = {}) => {
  const registry = options.registry ?? process.env.OIRAT_IMAGE_REGISTRY ?? 'registry.ide-newton.ts.net'
  const repository = options.repository ?? process.env.OIRAT_IMAGE_REPOSITORY ?? 'lab/oirat'
  const tag = options.tag ?? process.env.OIRAT_IMAGE_TAG ?? execGit(['rev-parse', '--short', 'HEAD'])
  const version = options.version ?? process.env.OIRAT_VERSION ?? execGit(['describe', '--tags', '--always'])
  const commit = options.commit ?? process.env.OIRAT_COMMIT ?? execGit(['rev-parse', 'HEAD'])

  const result = await buildAndPushNixImage({
    service: 'oirat',
    imageName: 'oirat',
    packageAttr: 'oirat-image',
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
}
