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

  const registry = process.env.SAG_IMAGE_REGISTRY ?? 'registry.ide-newton.ts.net'
  const repository = process.env.SAG_IMAGE_REPOSITORY ?? 'lab/sag'
  const defaultTag = execGit(['rev-parse', '--short', 'HEAD'])
  const tag = process.env.SAG_IMAGE_TAG ?? defaultTag

  const imageResult = await buildImage({ registry, repository, tag, dryRun })
  console.log(`Image digest: ${imageResult.digest}`)

  if (dryRun) {
    console.log('Dry run complete; manifests and cluster state were not changed.')
    return
  }

  updateManifests({ imageDigest: imageResult.digest })

  await ensureNamespace()
  const kustomizePath = resolve(repoRoot, process.env.SAG_KUSTOMIZE_PATH ?? 'argocd/sag')
  if (noApply) {
    console.log('Skipping kubectl apply because --no-apply was requested.')
    return
  }
  await run('kubectl', ['apply', '-k', kustomizePath])
  await run('kubectl', ['rollout', 'status', 'deployment/sag', '-n', 'sag', '--timeout=180s'])
}

if (import.meta.main) {
  main().catch((error) => fatal('Failed to build and deploy sag', error))
}

function updateManifests({ imageDigest }: { imageDigest: string }) {
  const digest = imageDigest.split('@')[1]
  if (!digest?.startsWith('sha256:')) {
    throw new Error(`Expected sag image digest reference, got ${imageDigest}`)
  }

  const kustomizationPath = resolve(repoRoot, 'argocd/sag/kustomization.yaml')
  const kustomization = readFileSync(kustomizationPath, 'utf8')
  const updated = kustomization.replace(
    /(-\s*name:\s+registry\.ide-newton\.ts\.net\/lab\/sag\s*\n\s*(?:newName:\s+registry\.ide-newton\.ts\.net\/lab\/sag\s*\n\s*)?)(?:newTag|digest):\s*.*/,
    (_, prefix) => `${prefix}digest: ${digest}`,
  )

  if (updated === kustomization) {
    fatal(`Unable to update ${kustomizationPath}; image stanza changed`)
  }

  writeFileSync(kustomizationPath, updated)
  console.log(`Updated ${kustomizationPath} with digest ${digest}`)
}

async function ensureNamespace() {
  const result = Bun.spawnSync(['kubectl', 'get', 'namespace', 'sag'], {
    cwd: repoRoot,
    stdout: 'pipe',
    stderr: 'pipe',
  })
  if (result.exitCode === 0) {
    return
  }
  await run('kubectl', ['create', 'namespace', 'sag'])
}
