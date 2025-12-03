#!/usr/bin/env bun

import { resolve } from 'node:path'
import { repoRoot } from '../shared/cli'
import { buildAndPushDockerImage } from '../shared/docker'
import { execGit } from '../shared/git'

export type BuildOptions = {
  registry?: string
  repository?: string
  tag?: string
  context?: string
  dockerfile?: string
  platforms?: string[]
  codexAuthPath?: string
}

export const buildImage = async (options: BuildOptions = {}) => {
  const registry = options.registry ?? process.env.TORGHUT_FORWARDER_REGISTRY ?? 'registry.ide-newton.ts.net'
  const repository = options.repository ?? process.env.TORGHUT_FORWARDER_REPOSITORY ?? 'lab/torghut-forwarder'
  const tag = options.tag ?? process.env.TORGHUT_FORWARDER_TAG ?? execGit(['rev-parse', '--short', 'HEAD'])
  const context = resolve(repoRoot, options.context ?? 'services/torghut-forwarder')
  const dockerfile = resolve(repoRoot, options.dockerfile ?? 'services/torghut-forwarder/Dockerfile')
  const platforms = options.platforms ??
    process.env.TORGHUT_FORWARDER_PLATFORMS?.split(',').map((p) => p.trim()) ?? ['linux/arm64']

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
      FORWARDER_VERSION: version,
      FORWARDER_COMMIT: commit,
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
