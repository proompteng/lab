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

  const registry = process.env.SYNTHESIS_IMAGE_REGISTRY ?? 'registry.ide-newton.ts.net'
  const repository = process.env.SYNTHESIS_IMAGE_REPOSITORY ?? 'lab/synthesis'
  const defaultTag = execGit(['rev-parse', '--short', 'HEAD'])
  const tag = process.env.SYNTHESIS_IMAGE_TAG ?? defaultTag

  const imageResult = await buildImage({ registry, repository, tag, dryRun })
  console.log(`Image digest: ${imageResult.digest}`)

  if (dryRun) {
    console.log('Dry run complete; manifests and cluster state were not changed.')
    return
  }

  updateManifests({ imageDigest: imageResult.digest })

  const kustomizePath = resolve(repoRoot, process.env.SYNTHESIS_KUSTOMIZE_PATH ?? 'argocd/applications/synthesis')
  if (noApply) {
    console.log('Skipping kubectl apply because --no-apply was requested.')
    return
  }
  await run('kubectl', ['apply', '-k', kustomizePath])

  console.log('Commit and push the updated synthesis manifests after deployment.')
}

if (import.meta.main) {
  main().catch((error) => fatal('Failed to build and deploy synthesis', error))
}

export const __private = {
  execGit,
}

type ManifestUpdateOptions = {
  imageDigest: string
}

function updateManifests(options: ManifestUpdateOptions) {
  const digest = options.imageDigest.split('@')[1]
  if (!digest?.startsWith('sha256:')) {
    throw new Error(`Expected synthesis image digest reference, got ${options.imageDigest}`)
  }

  const kustomizationPath = resolve(repoRoot, 'argocd/applications/synthesis/kustomization.yaml')
  const kustomization = readFileSync(kustomizationPath, 'utf8')
  const updatedKustomization = kustomization.replace(
    /(-\s*name:\s+registry\.ide-newton\.ts\.net\/lab\/synthesis\s*\n\s*)(?:newTag|digest):\s*.*/,
    (_, prefix) => `${prefix}digest: ${digest}`,
  )

  if (kustomization === updatedKustomization) {
    console.warn('Warning: Synthesis kustomization was not updated; pattern may have changed.')
  } else {
    writeFileSync(kustomizationPath, updatedKustomization)
    console.log(`Updated ${kustomizationPath} with digest ${digest}`)
  }
}
