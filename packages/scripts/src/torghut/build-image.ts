#!/usr/bin/env bun

import { resolve } from 'node:path'
import { repoRoot } from '../shared/cli'
import { buildAndPushDockerImage } from '../shared/docker'
import { execGit } from '../shared/git'

export type BuildImageOptions = {
  registry?: string
  repository?: string
  tag?: string
  context?: string
  dockerfile?: string
  platforms?: string[]
  codexAuthPath?: string
}

export const buildImage = async (options: BuildImageOptions = {}) => {
  const registry = options.registry ?? process.env.TORGHUT_IMAGE_REGISTRY ?? 'registry.ide-newton.ts.net'
  const repository = options.repository ?? process.env.TORGHUT_IMAGE_REPOSITORY ?? 'lab/torghut'
  const tag = options.tag ?? process.env.TORGHUT_IMAGE_TAG ?? 'latest'
  const context = resolve(repoRoot, options.context ?? 'services/torghut')
  const dockerfile = resolve(repoRoot, options.dockerfile ?? 'services/torghut/Dockerfile')
  const platformsEnv = process.env.TORGHUT_IMAGE_PLATFORMS
  const platforms =
    options.platforms ??
    (platformsEnv
      ? platformsEnv
          .split(',')
          .map((p) => p.trim())
          .filter((p) => p.length > 0 && p.toLowerCase() !== 'none')
      : ['linux/arm64'])

  const version = execGit(['describe', '--tags', '--always'])
  const commit = execGit(['rev-parse', 'HEAD'])

  const result = await buildAndPushDockerImage({
    registry,
    repository,
    tag,
    context,
    dockerfile,
    platforms,
    buildArgs: {
      TORGHUT_VERSION: version,
      TORGHUT_COMMIT: commit,
    },
  })

  return { ...result, version, commit }
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
