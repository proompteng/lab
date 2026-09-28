#!/usr/bin/env bun

import { buildAndPushNixImage } from '../shared/nix-oci-deploy'
import { execGit } from '../shared/git'

export type BuildImageOptions = {
  registry?: string
  repository?: string
  tag?: string
  context?: string
  dockerfile?: string
  cacheRef?: string
  dryRun?: boolean
}

export const buildImage = async (options: BuildImageOptions = {}) => {
  const registry = options.registry ?? process.env.SYMPHONY_IMAGE_REGISTRY ?? 'registry.ide-newton.ts.net'
  const repository = options.repository ?? process.env.SYMPHONY_IMAGE_REPOSITORY ?? 'lab/symphony'
  const tag = options.tag ?? process.env.SYMPHONY_IMAGE_TAG ?? execGit(['rev-parse', '--short', 'HEAD'])
  const commit = execGit(['rev-parse', 'HEAD'])

  const result = await buildAndPushNixImage({
    service: 'symphony',
    imageName: 'symphony',
    packageAttr: 'symphony-image',
    registry,
    repository,
    tag,
    sourceSha: commit,
    latestTag: 'latest',
    dryRun: options.dryRun,
  })

  return { image: `${registry}/${repository}:${tag}`, digest: result.reference, commit }
}

if (import.meta.main) {
  const args = process.argv.slice(2)
  const cliTag = args[0]?.trim() && !args[0]?.startsWith('-') ? args[0] : undefined
  buildImage({ tag: cliTag, dryRun: args.includes('--dry-run') }).catch((error) => {
    console.error(error instanceof Error ? error.message : String(error))
    process.exit(1)
  })
}

export const __private = {
  execGit,
}
