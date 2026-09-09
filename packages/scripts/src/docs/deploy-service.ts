#!/usr/bin/env bun

import { readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'

import { ensureCli, fatal, repoRoot, run } from '../shared/cli'
import { execGit } from '../shared/git'
import { buildImage } from './build-image'

export const main = async () => {
  const args = new Set(process.argv.slice(2))
  const dryRun = args.has('--dry-run')
  const noApply = dryRun || args.has('--no-apply')

  ensureCli('kubectl')

  const registry = process.env.DOCS_IMAGE_REGISTRY ?? 'registry.ide-newton.ts.net'
  const repository = process.env.DOCS_IMAGE_REPOSITORY ?? 'lab/docs'
  const defaultTag = execGit(['rev-parse', '--short', 'HEAD'])
  const tag = process.env.DOCS_IMAGE_TAG ?? defaultTag

  const imageResult = await buildImage({ registry, repository, tag, dryRun })
  console.log(`Image digest: ${imageResult.digest}`)

  if (dryRun) {
    console.log('Dry run complete; manifests and cluster state were not changed.')
    return
  }

  updateManifests({ imageDigest: imageResult.digest })

  const kustomizePath = resolve(repoRoot, process.env.DOCS_KUSTOMIZE_PATH ?? 'argocd/applications/docs')
  if (noApply) {
    console.log('Skipping kubectl apply because --no-apply was requested.')
    return
  }
  await run('kubectl', ['apply', '-k', kustomizePath])
  const namespace = resolveDeploymentNamespace(kustomizePath)
  const deploymentName = process.env.DOCS_K8S_DEPLOYMENT ?? 'docs'
  await run('kubectl', ['rollout', 'status', `deployment/${deploymentName}`, '-n', namespace])
}

if (import.meta.main) {
  main().catch((error) => fatal('Failed to build and deploy docs', error))
}

export const __private = {
  execGit,
  updateKustomizationContent,
}

type ManifestUpdateOptions = {
  imageDigest: string
}

function updateManifests(options: ManifestUpdateOptions) {
  const kustomizationPath = resolve(repoRoot, 'argocd/applications/docs/kustomization.yaml')
  const kustomization = readFileSync(kustomizationPath, 'utf8')
  const updatedKustomization = updateKustomizationContent(kustomization, options.imageDigest)

  writeFileSync(kustomizationPath, updatedKustomization)
  console.log(`Updated ${kustomizationPath} with digest ${options.imageDigest.split('@')[1]}`)
}

function updateKustomizationContent(kustomization: string, imageDigest: string) {
  const digest = imageDigest.split('@')[1]
  if (!digest || !/^sha256:[0-9a-f]{64}$/.test(digest)) {
    throw new Error(`Expected docs image digest reference, got ${imageDigest}`)
  }

  const imageEntryPattern = /(-\s*name:\s+registry\.ide-newton\.ts\.net\/lab\/docs\s*\n\s*)(?:newTag|digest):\s*.*/
  if (!imageEntryPattern.test(kustomization)) throw new Error('Docs Kustomization image entry was not found')
  return kustomization.replace(imageEntryPattern, (_, prefix) => `${prefix}digest: ${digest}`)
}

function resolveDeploymentNamespace(kustomizePath: string) {
  const envNamespace = process.env.DOCS_K8S_NAMESPACE?.trim()
  if (envNamespace) return envNamespace
  try {
    const kustomization = readFileSync(resolve(kustomizePath, 'kustomization.yaml'), 'utf8')
    const match = kustomization.match(/^namespace:\s*([^\s#]+)/m)
    if (match?.[1]) return match[1]
  } catch {
    // fall through to deployment metadata/default below
  }
  try {
    const deployment = readFileSync(resolve(kustomizePath, 'deployment.yaml'), 'utf8')
    const match = deployment.match(/^\s*namespace:\s*([^\s#]+)/m)
    if (match?.[1]) return match[1]
  } catch {
    // fall through to default below
  }
  return 'docs'
}
