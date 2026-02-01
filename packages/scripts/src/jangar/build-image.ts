#!/usr/bin/env bun

import { copyFileSync, cpSync, existsSync, mkdtempSync, rmSync } from 'node:fs'
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
  codexAuthPath?: string
  cacheRef?: string
}

const createPrunedContext = async (): Promise<{ dir: string; cleanup: () => void }> => {
  ensureCli('bunx')

  const dir = mkdtempSync(resolve(tmpdir(), 'jangar-prune-'))
  const cleanup = () => rmSync(dir, { recursive: true, force: true })

  try {
    await run('bunx', ['turbo', 'prune', '--scope=@proompteng/jangar', '--docker', `--out-dir=${dir}`], {
      cwd: repoRoot,
    })

    // `turbo prune --docker` doesn't currently include this file, but our TS configs extend it.
    copyFileSync(resolve(repoRoot, 'tsconfig.base.json'), resolve(dir, 'tsconfig.base.json'))
    const skillsSource = resolve(repoRoot, 'skills')
    if (existsSync(skillsSource)) {
      cpSync(skillsSource, resolve(dir, 'skills'), { recursive: true })
    }
    const agentctlSource = resolve(repoRoot, 'services/jangar/agentctl')
    if (existsSync(agentctlSource)) {
      cpSync(agentctlSource, resolve(dir, 'full/services/jangar/agentctl'), { recursive: true })
      cpSync(agentctlSource, resolve(dir, 'json/services/jangar/agentctl'), { recursive: true })
    }
    const outputSource = resolve(repoRoot, 'services/jangar/.output')
    const outputEntry = resolve(outputSource, 'server/index.mjs')
    if (existsSync(outputEntry)) {
      cpSync(outputSource, resolve(dir, 'full/services/jangar/.output'), { recursive: true })
    } else if (existsSync(outputSource)) {
      console.warn('Skipping prebuilt .output: missing services/jangar/.output/server/index.mjs')
    }
    return { dir, cleanup }
  } catch (error) {
    cleanup()
    throw error
  }
}

export const buildImage = async (options: BuildImageOptions = {}) => {
  const registry = options.registry ?? process.env.JANGAR_IMAGE_REGISTRY ?? 'registry.ide-newton.ts.net'
  const repository = options.repository ?? process.env.JANGAR_IMAGE_REPOSITORY ?? 'lab/jangar'
  const tag = options.tag ?? process.env.JANGAR_IMAGE_TAG ?? execGit(['rev-parse', '--short', 'HEAD'])
  const usePrune = options.context === undefined && process.env.JANGAR_BUILD_CONTEXT === undefined

  const dockerfile = resolve(
    repoRoot,
    options.dockerfile ?? process.env.JANGAR_DOCKERFILE ?? 'services/jangar/Dockerfile',
  )
  const version = options.version ?? process.env.JANGAR_VERSION ?? tag
  const commit = options.commit ?? process.env.JANGAR_COMMIT ?? execGit(['rev-parse', 'HEAD'])
  const codexAuthPath =
    options.codexAuthPath ?? process.env.CODEX_AUTH_PATH ?? resolve(process.env.HOME ?? '', '.codex/auth.json')
  const cacheRef = options.cacheRef ?? process.env.JANGAR_BUILD_CACHE_REF ?? `${registry}/${repository}:buildcache`

  let context: string
  let pruneCleanup: (() => void) | undefined

  try {
    if (usePrune) {
      const pruned = await createPrunedContext()
      context = pruned.dir
      pruneCleanup = pruned.cleanup
    } else {
      context = resolve(repoRoot, options.context ?? process.env.JANGAR_BUILD_CONTEXT ?? '.')
    }

    const codexAuthPathForDocker = existsSync(codexAuthPath) ? codexAuthPath : undefined
    if (!codexAuthPathForDocker) {
      console.warn(`Codex auth not found at ${codexAuthPath}; build will proceed without it.`)
    }

    const buildArgs: Record<string, string> = {
      JANGAR_VERSION: version,
      JANGAR_COMMIT: commit,
    }
    if (process.env.BUILDX_VERSION) {
      buildArgs.BUILDX_VERSION = process.env.BUILDX_VERSION
    }

    const result = await buildAndPushDockerImage({
      registry,
      repository,
      tag,
      context,
      dockerfile,
      buildArgs,
      codexAuthPath: codexAuthPathForDocker,
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

export const __private = { execGit }
