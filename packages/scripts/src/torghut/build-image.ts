#!/usr/bin/env bun

import { execGit } from '../shared/git'
import { buildAndPushNixImage } from '../shared/nix-oci-deploy'

export type BuildImageOptions = {
  registry?: string
  repository?: string
  tag?: string
  dryRun?: boolean
}

let buildAndPushNixImageImpl = buildAndPushNixImage
let execGitImpl = execGit

export const buildImage = async (options: BuildImageOptions = {}) => {
  const registry = options.registry ?? process.env.TORGHUT_IMAGE_REGISTRY ?? 'registry.ide-newton.ts.net'
  const repository = options.repository ?? process.env.TORGHUT_IMAGE_REPOSITORY ?? 'lab/torghut'
  const tag = options.tag ?? process.env.TORGHUT_IMAGE_TAG ?? 'latest'

  const version = execGitImpl(['describe', '--tags', '--always'])
  const commit = execGitImpl(['rev-parse', 'HEAD'])

  const result = await buildAndPushNixImageImpl({
    service: 'torghut',
    imageName: 'torghut',
    packageAttr: 'torghut-image',
    registry,
    repository,
    tag,
    sourceSha: commit,
    latestTag: 'latest',
    dryRun: options.dryRun,
  })

  return { image: `${registry}/${repository}:${tag}`, digest: result.reference, version, commit }
}

if (import.meta.main) {
  buildImage().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error))
    process.exit(1)
  })
}

export const __private = {
  execGit,
  setBuildAndPushNixImage: (impl: typeof buildAndPushNixImage = buildAndPushNixImage) => {
    buildAndPushNixImageImpl = impl
  },
  setExecGit: (impl: typeof execGit = execGit) => {
    execGitImpl = impl
  },
}
