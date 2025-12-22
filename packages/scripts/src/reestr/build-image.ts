#!/usr/bin/env bun

import { resolve } from 'node:path'
import { repoRoot } from '../shared/cli'
import { buildAndPushDockerImage } from '../shared/docker'

export type BuildImageOptions = {
  registry?: string
  repository?: string
  tag?: string
  context?: string
  dockerfile?: string
}

export const buildImage = async (options: BuildImageOptions = {}) => {
  const registry = options.registry ?? process.env.REESTR_IMAGE_REGISTRY ?? 'registry.ide-newton.ts.net'
  const repository = options.repository ?? process.env.REESTR_IMAGE_REPOSITORY ?? 'lab/reestr'
  const tag = options.tag ?? process.env.REESTR_IMAGE_TAG ?? 'latest'
  const context = resolve(repoRoot, options.context ?? '.')
  const dockerfile = resolve(repoRoot, options.dockerfile ?? 'apps/reestr/Dockerfile')

  return buildAndPushDockerImage({
    registry,
    repository,
    tag,
    context,
    dockerfile,
  })
}

if (import.meta.main) {
  buildImage().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error))
    process.exit(1)
  })
}
