#!/usr/bin/env bun

import { buildAndPushNixImage } from '../shared/nix-oci-deploy'
import { execGit } from '../shared/git'

export type BuildImageOptions = {
  registry?: string
  repository?: string
  tag?: string
  dryRun?: boolean
}

const parseTagArg = (args: string[]): string | undefined => {
  const first = args[0]?.trim()
  if (!first) return undefined
  if (first.startsWith('-')) return undefined
  return first
}

export const buildImage = async (options: BuildImageOptions = {}) => {
  const registry = options.registry ?? process.env.PROOMPTENG_IMAGE_REGISTRY ?? 'registry.ide-newton.ts.net'
  const repository = options.repository ?? process.env.PROOMPTENG_IMAGE_REPOSITORY ?? 'lab/proompteng'
  const tag = options.tag ?? process.env.PROOMPTENG_IMAGE_TAG ?? execGit(['rev-parse', '--short', 'HEAD'])
  const commit = execGit(['rev-parse', 'HEAD'])

  const result = await buildAndPushNixImage({
    service: 'proompteng',
    imageName: 'proompteng',
    packageAttr: 'proompteng-image',
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
  const cliTag = parseTagArg(args)
  buildImage({ tag: cliTag, dryRun: args.includes('--dry-run') }).catch((error) => {
    console.error(error instanceof Error ? error.message : String(error))
    process.exit(1)
  })
}

export const __private = {
  parseTagArg,
}
