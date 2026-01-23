#!/usr/bin/env bun

import { readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { ensureCli, fatal, repoRoot, run } from '../shared/cli'
import { inspectImageDigest } from '../shared/docker'
import { execGit } from '../shared/git'
import { buildImage } from './build-image'

export const main = async () => {
  ensureCli('kubectl')

  const registry = process.env.FACTEUR_IMAGE_REGISTRY ?? 'registry.ide-newton.ts.net'
  const repository = process.env.FACTEUR_IMAGE_REPOSITORY ?? 'lab/facteur'
  const defaultTag = execGit(['rev-parse', '--short', 'HEAD'])
  const tag = process.env.FACTEUR_IMAGE_TAG ?? defaultTag
  const image = `${registry}/${repository}:${tag}`

  await buildImage({ registry, repository, tag })

  const repoDigest = inspectImageDigest(image)
  console.log(`Image digest: ${repoDigest}`)

  updateManifests({ tag, rolloutTimestamp: new Date().toISOString() })

  const overlay = resolve(
    repoRoot,
    process.env.FACTEUR_KUSTOMIZE_PATH ?? 'argocd/applications/facteur/overlays/cluster',
  )
  await run('kubectl', ['apply', '-k', overlay])
}

if (import.meta.main) {
  main().catch((error) => fatal('Failed to build and deploy facteur', error))
}

export const __private = {
  execGit,
}

type ManifestUpdateOptions = {
  tag: string
  rolloutTimestamp: string
}

function updateManifests(options: ManifestUpdateOptions) {
  const { tag, rolloutTimestamp } = options

  const kustomizationPath = resolve(repoRoot, 'argocd/applications/facteur/overlays/cluster/kustomization.yaml')
  const kustomization = readFileSync(kustomizationPath, 'utf8')
  const updatedKustomization = kustomization.replace(
    /(-\s*name:\s+registry\.ide-newton\.ts\.net\/lab\/facteur\s*\n\s*newTag:\s*)(.+)/,
    (_, prefix) => `${prefix}${tag}`,
  )
  if (kustomization === updatedKustomization) {
    console.warn('Warning: Facteur kustomization was not updated; pattern may have changed.')
  } else {
    writeFileSync(kustomizationPath, updatedKustomization)
    console.log(`Updated ${kustomizationPath} with tag ${tag}`)
  }

  const servicePath = resolve(repoRoot, 'argocd/applications/facteur/overlays/cluster/facteur-service.yaml')
  const service = readFileSync(servicePath, 'utf8')
  const updatedService = service.replace(/(deploy\.knative\.dev\/rollout:\s*").+(")/, `$1${rolloutTimestamp}$2`)
  if (service === updatedService) {
    console.warn('Warning: Facteur service rollout annotation was not updated; pattern may have changed.')
  } else {
    writeFileSync(servicePath, updatedService)
    console.log(`Updated ${servicePath} rollout annotation to ${rolloutTimestamp}`)
  }
}
