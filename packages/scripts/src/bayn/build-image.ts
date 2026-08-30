#!/usr/bin/env bun

import { execGit } from '../shared/git'
import { buildAndPushNixImage } from '../shared/nix-oci-deploy'

export type BuildImageOptions = {
  registry?: string
  repository?: string
  tag?: string
  dryRun?: boolean
}

const parseTagArg = (args: string[]): string | undefined => {
  const first = args[0]?.trim()
  if (!first || first.startsWith('-')) return undefined
  return first
}

export const buildImage = async (options: BuildImageOptions = {}) => {
  const registry = options.registry ?? process.env.BAYN_IMAGE_REGISTRY ?? 'registry.ide-newton.ts.net'
  const repository = options.repository ?? process.env.BAYN_IMAGE_REPOSITORY ?? 'lab/bayn'
  const tag = options.tag ?? process.env.BAYN_IMAGE_TAG ?? execGit(['rev-parse', '--short', 'HEAD'])
  const sourceSha = execGit(['rev-parse', 'HEAD'])

  return buildAndPushNixImage({
    service: 'bayn',
    imageName: 'bayn',
    packageAttr: 'bayn-image',
    registry,
    repository,
    tag,
    sourceSha,
    latestTag: 'latest',
    dryRun: options.dryRun,
  })
}

if (import.meta.main) {
  const args = process.argv.slice(2)
  buildImage({ tag: parseTagArg(args), dryRun: args.includes('--dry-run') }).catch((error) => {
    console.error(error instanceof Error ? error.message : String(error))
    process.exit(1)
  })
}

export const __private = { parseTagArg }
