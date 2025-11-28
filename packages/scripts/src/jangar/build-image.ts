#!/usr/bin/env bun

import { mkdirSync, existsSync, copyFileSync, rmSync } from 'node:fs'
import { resolve, dirname } from 'node:path'

import { repoRoot } from '../shared/cli'
import { buildAndPushDockerImage } from '../shared/docker'
import { execGit } from '../shared/git'

export type BuildImageOptions = {
  registry?: string
  repository?: string
  tag?: string
  context?: string
  dockerfile?: string
  version?: string
  commit?: string
  codexAuthPath?: string
}

export const buildImage = async (options: BuildImageOptions = {}) => {
  const registry = options.registry ?? process.env.JANGAR_IMAGE_REGISTRY ?? 'registry.ide-newton.ts.net'
  const repository = options.repository ?? process.env.JANGAR_IMAGE_REPOSITORY ?? 'lab/jangar'
  const tag = options.tag ?? process.env.JANGAR_IMAGE_TAG ?? execGit(['rev-parse', '--short', 'HEAD'])
  const context = resolve(repoRoot, options.context ?? process.env.JANGAR_BUILD_CONTEXT ?? '.')
  const dockerfile = resolve(
    repoRoot,
    options.dockerfile ?? process.env.JANGAR_DOCKERFILE ?? 'services/jangar/Dockerfile',
  )
  const version = options.version ?? process.env.JANGAR_VERSION ?? tag
  const commit = options.commit ?? process.env.JANGAR_COMMIT ?? execGit(['rev-parse', 'HEAD'])
  const codexAuthPath =
    options.codexAuthPath ?? process.env.CODEX_AUTH_PATH ?? resolve(process.env.HOME ?? '', '.codex/auth.json')

  // Stage auth into build context so COPY succeeds, then clean up
  let stagedAuth = false
  const stagedPath = resolve(repoRoot, 'services/jangar/.codex/auth.json')
  try {
    if (existsSync(codexAuthPath)) {
      mkdirSync(dirname(stagedPath), { recursive: true })
      copyFileSync(codexAuthPath, stagedPath)
      stagedAuth = true
    } else {
      console.warn(`Codex auth not found at ${codexAuthPath}; build will proceed without it.`)
    }

    const result = await buildAndPushDockerImage({
      registry,
      repository,
      tag,
      context,
      dockerfile,
      buildArgs: {
        JANGAR_VERSION: version,
        JANGAR_COMMIT: commit,
      },
      codexAuthPath,
    })

    return { ...result, version, commit }
  } finally {
    if (stagedAuth) {
      try {
        rmSync(stagedPath, { force: true })
        rmSync(dirname(stagedPath), { recursive: true, force: true })
      } catch {
        // ignore cleanup errors
      }
    }
  }
}

if (import.meta.main) {
  buildImage().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error))
    process.exit(1)
  })
}

export const __private = { execGit }
