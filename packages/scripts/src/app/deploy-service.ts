#!/usr/bin/env bun

import { readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { ensureCli, fatal, repoRoot, run } from '../shared/cli'
import { inspectImageDigest } from '../shared/docker'
import { execGit } from '../shared/git'
import { buildImage } from './build-image'

export const main = async () => {
  ensureCli('kubectl')

  const registry = process.env.APP_IMAGE_REGISTRY ?? 'registry.ide-newton.ts.net'
  const repository = process.env.APP_IMAGE_REPOSITORY ?? 'lab/app'
  const defaultTag = execGit(['rev-parse', '--short', 'HEAD'])
  const tag = process.env.APP_IMAGE_TAG ?? defaultTag
  const image = `${registry}/${repository}:${tag}`

  await buildImage({ registry, repository, tag })

  const repoDigest = inspectImageDigest(image)
  console.log(`Image digest: ${repoDigest}`)

  updateManifests({ tag })
  console.log('Remember to commit and push the updated manifests after deployment.')

  const kustomizePath = resolve(repoRoot, process.env.APP_KUSTOMIZE_PATH ?? 'argocd/applications/app')
  await run('kubectl', ['apply', '-k', kustomizePath])
}

if (import.meta.main) {
  main().catch((error) => fatal('Failed to build and deploy app', error))
}

export const __private = {
  execGit,
}

type ManifestUpdateOptions = {
  tag: string
}

function updateManifests(options: ManifestUpdateOptions) {
  const { tag } = options

  const kustomizationPath = resolve(repoRoot, 'argocd/applications/app/kustomization.yaml')
  const kustomization = readFileSync(kustomizationPath, 'utf8')
  const updatedKustomization = kustomization.replace(
    /(-\s*name:\s+registry\.ide-newton\.ts\.net\/lab\/app\s*\n\s*newTag:\s*).*/,
    (_, prefix) => `${prefix}"${tag}"`,
  )

  if (kustomization === updatedKustomization) {
    console.warn('Warning: App kustomization was not updated; pattern may have changed.')
  } else {
    writeFileSync(kustomizationPath, updatedKustomization)
    console.log(`Updated ${kustomizationPath} with tag ${tag}`)
  }
}
