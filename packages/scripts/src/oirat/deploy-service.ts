#!/usr/bin/env bun

import { readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { ensureCli, fatal, repoRoot, run } from '../shared/cli'
import { execGit } from '../shared/git'
import { buildImage } from './build-image'

export const main = async () => {
  ensureCli('kubectl')

  const registry = process.env.OIRAT_IMAGE_REGISTRY ?? 'registry.ide-newton.ts.net'
  const repository = process.env.OIRAT_IMAGE_REPOSITORY ?? 'lab/oirat'
  const defaultTag = execGit(['rev-parse', '--short', 'HEAD'])
  const tag = process.env.OIRAT_IMAGE_TAG ?? defaultTag

  const imageResult = await buildImage({ registry, repository, tag })

  console.log(`Image digest: ${imageResult.digest}`)

  updateManifests({ imageDigest: imageResult.digest, rolloutTimestamp: new Date().toISOString() })

  const kustomizePath = resolve(repoRoot, process.env.OIRAT_KUSTOMIZE_PATH ?? 'argocd/applications/oirat')
  await run('kubectl', ['apply', '-k', kustomizePath])
}

if (import.meta.main) {
  main().catch((error) => fatal('Failed to build and deploy oirat', error))
}

export const __private = {
  execGit,
}

type ManifestUpdateOptions = {
  imageDigest: string
  rolloutTimestamp: string
}

function updateManifests(options: ManifestUpdateOptions) {
  const { imageDigest, rolloutTimestamp } = options
  const digest = imageDigest.split('@')[1]
  if (!digest?.startsWith('sha256:')) {
    throw new Error(`Expected oirat image digest reference, got ${imageDigest}`)
  }

  const kustomizationPath = resolve(repoRoot, 'argocd/applications/oirat/kustomization.yaml')
  const kustomization = readFileSync(kustomizationPath, 'utf8')
  const updatedKustomization = kustomization.replace(
    /(-\s*name:\s+registry\.ide-newton\.ts\.net\/lab\/oirat\s*\n\s*)(?:newTag|digest):\s*.*/,
    (_, prefix) => `${prefix}digest: ${digest}`,
  )
  if (kustomization === updatedKustomization) {
    console.warn('Warning: Oirat kustomization was not updated; pattern may have changed.')
  } else {
    writeFileSync(kustomizationPath, updatedKustomization)
    console.log(`Updated ${kustomizationPath} with digest ${digest}`)
  }

  const deploymentPath = resolve(repoRoot, 'argocd/applications/oirat/deployment.yaml')
  const deployment = readFileSync(deploymentPath, 'utf8')
  const updatedDeployment = deployment.replace(
    /(kubectl\.kubernetes\.io\/restartedAt:\s*).*/,
    `$1"${rolloutTimestamp}"`,
  )
  if (deployment === updatedDeployment) {
    console.warn('Warning: Oirat deployment rollout annotation was not updated; pattern may have changed.')
  } else {
    writeFileSync(deploymentPath, updatedDeployment)
    console.log(`Updated ${deploymentPath} rollout annotation to ${rolloutTimestamp}`)
  }
}
