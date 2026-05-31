#!/usr/bin/env bun

import { readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'

import { ensureCli, fatal, repoRoot, run } from '../shared/cli'
import { inspectImageDigest } from '../shared/docker'
import { execGit } from '../shared/git'
import { buildImage } from './build-image'

export const main = async () => {
  ensureCli('kubectl')

  const registry = process.env.OLDEN_IMAGE_REGISTRY ?? 'registry.ide-newton.ts.net'
  const repository = process.env.OLDEN_IMAGE_REPOSITORY ?? 'lab/olden'
  const defaultTag = execGit(['rev-parse', '--short', 'HEAD'])
  const tag = process.env.OLDEN_IMAGE_TAG ?? defaultTag
  const image = `${registry}/${repository}:${tag}`

  await buildImage({ registry, repository, tag })

  const repoDigest = inspectImageDigest(image)
  console.log(`Image digest: ${repoDigest}`)

  updateManifests({ tag })

  const kustomizePath = resolve(repoRoot, process.env.OLDEN_KUSTOMIZE_PATH ?? 'argocd/applications/olden')
  await run('kubectl', ['apply', '-k', kustomizePath])
  const namespace = resolveDeploymentNamespace(kustomizePath)
  const deploymentName = process.env.OLDEN_K8S_DEPLOYMENT ?? 'olden'
  await run('kubectl', ['rollout', 'status', `deployment/${deploymentName}`, '-n', namespace])
}

if (import.meta.main) {
  main().catch((error) => fatal('Failed to build and deploy olden', error))
}

export const __private = {
  execGit,
}

type ManifestUpdateOptions = {
  tag: string
}

function updateManifests(options: ManifestUpdateOptions) {
  const { tag } = options

  const kustomizationPath = resolve(repoRoot, 'argocd/applications/olden/kustomization.yaml')
  const kustomization = readFileSync(kustomizationPath, 'utf8')
  const updatedKustomization = kustomization.replace(
    /(-\s*name:\s+registry\.ide-newton\.ts\.net\/lab\/olden\s*\n\s*newTag:\s*).*/,
    (_, prefix) => `${prefix}"${tag}"`,
  )

  if (kustomization === updatedKustomization) {
    console.warn('Warning: olden kustomization was not updated; pattern may have changed.')
  } else {
    writeFileSync(kustomizationPath, updatedKustomization)
    console.log(`Updated ${kustomizationPath} with tag ${tag}`)
  }
}

function resolveDeploymentNamespace(kustomizePath: string) {
  const envNamespace = process.env.OLDEN_K8S_NAMESPACE?.trim()
  if (envNamespace) {
    return envNamespace
  }
  try {
    const kustomization = readFileSync(resolve(kustomizePath, 'kustomization.yaml'), 'utf8')
    const match = kustomization.match(/^namespace:\s*([^\s#]+)/m)
    if (match?.[1]) {
      return match[1]
    }
  } catch {
    // fall through to deployment metadata/default below
  }
  try {
    const deployment = readFileSync(resolve(kustomizePath, 'deployment.yaml'), 'utf8')
    const match = deployment.match(/^\s*namespace:\s*([^\s#]+)/m)
    if (match?.[1]) {
      return match[1]
    }
  } catch {
    // fall through to default below
  }
  return 'olden'
}
