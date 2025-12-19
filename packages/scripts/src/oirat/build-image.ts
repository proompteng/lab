#!/usr/bin/env bun

import { copyFileSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { ensureCli, repoRoot, run } from '../shared/cli'
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
  cacheRef?: string
}

const createPrunedContext = async (): Promise<{ dir: string; cleanup: () => void }> => {
  ensureCli('bunx')

  const dir = mkdtempSync(resolve(tmpdir(), 'oirat-prune-'))
  const cleanup = () => rmSync(dir, { recursive: true, force: true })

  try {
    await run('bunx', ['turbo', 'prune', '--scope=@proompteng/oirat', '--docker', `--out-dir=${dir}`], {
      cwd: repoRoot,
    })

    copyFileSync(resolve(repoRoot, 'tsconfig.base.json'), resolve(dir, 'tsconfig.base.json'))
    return { dir, cleanup }
  } catch (error) {
    cleanup()
    throw error
  }
}

export const buildImage = async (options: BuildImageOptions = {}) => {
  const registry = options.registry ?? process.env.OIRAT_IMAGE_REGISTRY ?? 'registry.ide-newton.ts.net'
  const repository = options.repository ?? process.env.OIRAT_IMAGE_REPOSITORY ?? 'lab/oirat'
  const tag = options.tag ?? process.env.OIRAT_IMAGE_TAG ?? execGit(['rev-parse', '--short', 'HEAD'])
  const usePrune = options.context === undefined && process.env.OIRAT_BUILD_CONTEXT === undefined

  const dockerfile = resolve(
    repoRoot,
    options.dockerfile ?? process.env.OIRAT_DOCKERFILE ?? 'services/oirat/Dockerfile',
  )
  const version = options.version ?? process.env.OIRAT_VERSION ?? execGit(['describe', '--tags', '--always'])
  const commit = options.commit ?? process.env.OIRAT_COMMIT ?? execGit(['rev-parse', 'HEAD'])
  const cacheRef = options.cacheRef ?? process.env.OIRAT_BUILD_CACHE_REF ?? `${registry}/${repository}:buildcache`

  let context: string
  let pruneCleanup: (() => void) | undefined

  try {
    if (usePrune) {
      const pruned = await createPrunedContext()
      context = pruned.dir
      pruneCleanup = pruned.cleanup
    } else {
      context = resolve(repoRoot, options.context ?? process.env.OIRAT_BUILD_CONTEXT ?? '.')
    }

    const result = await buildAndPushDockerImage({
      registry,
      repository,
      tag,
      context,
      dockerfile,
      buildArgs: {
        OIRAT_VERSION: version,
        OIRAT_COMMIT: commit,
      },
      cacheRef,
    })

    return { ...result, version, commit }
  } finally {
    pruneCleanup?.()
  }
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
