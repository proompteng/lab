#!/usr/bin/env bun

import { readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'

import { ensureCli, fatal, repoRoot, run } from '../shared/cli'
import { execGit } from '../shared/git'
import { buildImage } from './build-image'

export const main = async () => {
  ensureCli('kubectl')

  const registry = process.env.BUMBA_IMAGE_REGISTRY ?? 'registry.ide-newton.ts.net'
  const repository = process.env.BUMBA_IMAGE_REPOSITORY ?? 'lab/bumba'
  const defaultTag = execGit(['rev-parse', '--short', 'HEAD'])
  const tag = process.env.BUMBA_IMAGE_TAG ?? defaultTag

  const imageResult = await buildImage({ registry, repository, tag })

  console.log(`Image digest: ${imageResult.digest}`)

  updateManifests({ imageDigest: imageResult.digest, rolloutTimestamp: new Date().toISOString() })

  const kustomizePath = resolve(repoRoot, process.env.BUMBA_KUSTOMIZE_PATH ?? 'argocd/applications/bumba')
  await run('kubectl', ['apply', '-k', kustomizePath])
  const namespace = resolveKustomizeNamespace(kustomizePath)
  const deploymentName = process.env.BUMBA_K8S_DEPLOYMENT ?? 'bumba'
  await run('kubectl', ['rollout', 'status', `deployment/${deploymentName}`, '-n', namespace])
}

if (import.meta.main) {
  main().catch((error) => fatal('Failed to build and deploy bumba', error))
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
    throw new Error(`Expected bumba image digest reference, got ${imageDigest}`)
  }

  const kustomizationPath = resolve(repoRoot, 'argocd/applications/bumba/kustomization.yaml')
  const kustomization = readFileSync(kustomizationPath, 'utf8')
  const updatedKustomization = kustomization.replace(
    /(-\s*name:\s+registry\.ide-newton\.ts\.net\/lab\/bumba\s*\n\s*)(?:newTag|digest):\s*.*/,
    (_, prefix) => `${prefix}digest: ${digest}`,
  )
  if (kustomization === updatedKustomization) {
    console.warn('Warning: bumba kustomization was not updated; pattern may have changed.')
  } else {
    writeFileSync(kustomizationPath, updatedKustomization)
    console.log(`Updated ${kustomizationPath} with digest ${digest}`)
  }

  const deploymentPath = resolve(repoRoot, 'argocd/applications/bumba/deployment.yaml')
  const deployment = readFileSync(deploymentPath, 'utf8')
  const updatedDeployment = deployment.replace(
    /(kubectl\.kubernetes\.io\/restartedAt:\s*).*/,
    `$1"${rolloutTimestamp}"`,
  )
  if (deployment === updatedDeployment) {
    console.warn('Warning: bumba deployment rollout annotation was not updated; pattern may have changed.')
  } else {
    writeFileSync(deploymentPath, updatedDeployment)
    console.log(`Updated ${deploymentPath} rollout annotation to ${rolloutTimestamp}`)
  }
}

function resolveKustomizeNamespace(kustomizePath: string) {
  const envNamespace = process.env.BUMBA_K8S_NAMESPACE?.trim()
  if (envNamespace) {
    return envNamespace
  }
  try {
    const kustomizationPath = resolve(kustomizePath, 'kustomization.yaml')
    const kustomization = readFileSync(kustomizationPath, 'utf8')
    const match = kustomization.match(/^namespace:\s*([^\s#]+)/m)
    if (match?.[1]) {
      return match[1]
    }
  } catch {
    // fall back to default below
  }
  return 'jangar'
}
