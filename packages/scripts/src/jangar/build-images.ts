#!/usr/bin/env bun

import { copyFileSync, cpSync, existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'

import { ensureCli, repoRoot } from '../shared/cli'
import { buildAndPushDockerImages, type DockerBakeTargetOptions, type DockerCacheMode } from '../shared/docker'
import { execGit } from '../shared/git'

const parsePlatforms = (value: string | undefined): string[] | undefined => {
  if (!value) return undefined
  const platforms = value
    .split(',')
    .map((platform) => platform.trim())
    .filter(Boolean)

  return platforms.length > 0 ? platforms : undefined
}

const parseCacheMode = (value: string | undefined): DockerCacheMode | undefined => {
  if (!value) return undefined
  const normalized = value.trim().toLowerCase()
  if (normalized === 'min') return 'min'
  if (normalized === 'max') return 'max'
  return undefined
}

const createPrunedContext = async (): Promise<{ dir: string; cleanup: () => void }> => {
  ensureCli('bunx')

  const dir = mkdtempSync(resolve(tmpdir(), 'jangar-prune-'))
  const cleanup = () => rmSync(dir, { recursive: true, force: true })

  try {
    await Bun.$`bunx turbo prune --scope=@proompteng/jangar --docker --out-dir=${dir}`.cwd(repoRoot)

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

    const cxToolsSource = resolve(repoRoot, 'packages/cx-tools')
    if (existsSync(cxToolsSource)) {
      cpSync(cxToolsSource, resolve(dir, 'full/packages/cx-tools'), { recursive: true })
      cpSync(cxToolsSource, resolve(dir, 'json/packages/cx-tools'), { recursive: true })
    }

    if (process.env.JANGAR_USE_PREBUILT_OUTPUT?.trim().toLowerCase() === 'true') {
      const outputSource = resolve(repoRoot, 'services/jangar/.output')
      const outputEntry = resolve(outputSource, 'server/index.mjs')
      const outputProto = resolve(outputSource, 'server/proto/proompteng/jangar/v1/agentctl.proto')
      if (existsSync(outputEntry) && existsSync(outputProto)) {
        cpSync(outputSource, resolve(dir, 'full/services/jangar/.output'), { recursive: true })
      } else if (existsSync(outputSource)) {
        console.warn('Skipping prebuilt .output: missing services/jangar/.output/server/index.mjs or agentctl.proto')
      }
    }

    return { dir, cleanup }
  } catch (error) {
    cleanup()
    throw error
  }
}

const buildImages = async () => {
  const registry = process.env.JANGAR_IMAGE_REGISTRY ?? 'registry.ide-newton.ts.net'
  const tag = process.env.JANGAR_IMAGE_TAG ?? execGit(['rev-parse', '--short', 'HEAD'])
  const usePrune = process.env.JANGAR_BUILD_CONTEXT === undefined
  const dockerfile = resolve(repoRoot, process.env.JANGAR_DOCKERFILE ?? 'services/jangar/Dockerfile')
  const version = process.env.JANGAR_VERSION ?? tag
  const commit = process.env.JANGAR_COMMIT ?? execGit(['rev-parse', 'HEAD'])
  const codexAuthPath = resolve(process.env.HOME ?? '', '.codex/auth.json')
  const codexAuthPathForDocker = existsSync(codexAuthPath) ? codexAuthPath : undefined
  const runtimeCacheRef = process.env.JANGAR_BUILD_CACHE_REF ?? `${registry}/lab/jangar:buildcache`
  const controlPlaneCacheRef =
    process.env.JANGAR_CONTROL_PLANE_BUILD_CACHE_REF ?? `${registry}/lab/jangar-control-plane:buildcache`
  const cacheMode = parseCacheMode(process.env.JANGAR_BUILD_CACHE_MODE)
  const platforms =
    parsePlatforms(process.env.JANGAR_IMAGE_PLATFORMS) ?? parsePlatforms(process.env.DOCKER_IMAGE_PLATFORMS)

  let context: string
  let cleanup: (() => void) | undefined

  try {
    if (usePrune) {
      const pruned = await createPrunedContext()
      context = pruned.dir
      cleanup = pruned.cleanup
    } else {
      context = resolve(repoRoot, process.env.JANGAR_BUILD_CONTEXT ?? '.')
    }

    const buildArgs: Record<string, string> = {
      JANGAR_VERSION: version,
      JANGAR_COMMIT: commit,
    }

    const buildNodeOptions = process.env.JANGAR_BUILD_NODE_OPTIONS?.trim()
    if (buildNodeOptions) buildArgs.JANGAR_BUILD_NODE_OPTIONS = buildNodeOptions
    const buildMinify = process.env.JANGAR_BUILD_MINIFY?.trim()
    if (buildMinify) buildArgs.JANGAR_BUILD_MINIFY = buildMinify
    const buildSourceMap = process.env.JANGAR_BUILD_SOURCEMAP?.trim()
    if (buildSourceMap) buildArgs.JANGAR_BUILD_SOURCEMAP = buildSourceMap
    const buildCi = process.env.JANGAR_BUILD_CI?.trim()
    if (buildCi) buildArgs.JANGAR_BUILD_CI = buildCi
    const buildLogLevel = process.env.JANGAR_BUILD_LOG_LEVEL?.trim()
    if (buildLogLevel) buildArgs.JANGAR_BUILD_LOG_LEVEL = buildLogLevel
    if (process.env.BUILDX_VERSION) buildArgs.BUILDX_VERSION = process.env.BUILDX_VERSION

    const targets: DockerBakeTargetOptions[] = [
      {
        name: 'jangar-runtime',
        registry,
        repository: process.env.JANGAR_IMAGE_REPOSITORY ?? 'lab/jangar',
        tag,
        context,
        dockerfile,
        buildArgs,
        codexAuthPath: codexAuthPathForDocker,
        cacheRef: runtimeCacheRef,
        cacheMode,
        platforms,
      },
      {
        name: 'jangar-control-plane',
        registry,
        repository: process.env.JANGAR_CONTROL_PLANE_IMAGE_REPOSITORY ?? 'lab/jangar-control-plane',
        tag,
        context,
        dockerfile,
        target: process.env.JANGAR_CONTROL_PLANE_DOCKER_TARGET ?? 'control-plane',
        buildArgs,
        codexAuthPath: codexAuthPathForDocker,
        cacheRef: controlPlaneCacheRef,
        cacheMode,
        platforms,
      },
    ]

    return await buildAndPushDockerImages({ targets })
  } finally {
    cleanup?.()
  }
}

if (import.meta.main) {
  buildImages().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error))
    process.exit(1)
  })
}
