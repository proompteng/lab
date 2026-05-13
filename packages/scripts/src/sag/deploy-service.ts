#!/usr/bin/env bun

import { readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'

import { ensureCli, fatal, repoRoot, run } from '../shared/cli'
import { inspectImageDigest } from '../shared/docker'
import { execGit } from '../shared/git'
import { buildImage } from './build-image'

export const main = async () => {
  ensureCli('kubectl')

  const registry = process.env.SAG_IMAGE_REGISTRY ?? 'registry.ide-newton.ts.net'
  const repository = process.env.SAG_IMAGE_REPOSITORY ?? 'lab/sag'
  const defaultTag = execGit(['rev-parse', '--short', 'HEAD'])
  const tag = process.env.SAG_IMAGE_TAG ?? defaultTag
  const image = `${registry}/${repository}:${tag}`

  await buildImage({ registry, repository, tag })
  const digest = inspectImageDigest(image)
  console.log(`Image digest: ${digest}`)

  updateManifests({ tag })

  await ensureNamespace()
  const kustomizePath = resolve(repoRoot, process.env.SAG_KUSTOMIZE_PATH ?? 'argocd/sag')
  await run('kubectl', ['apply', '-k', kustomizePath])
  await run('kubectl', ['rollout', 'status', 'deployment/sag', '-n', 'sag', '--timeout=180s'])
}

if (import.meta.main) {
  main().catch((error) => fatal('Failed to build and deploy sag', error))
}

function updateManifests({ tag }: { tag: string }) {
  const kustomizationPath = resolve(repoRoot, 'argocd/sag/kustomization.yaml')
  const kustomization = readFileSync(kustomizationPath, 'utf8')
  const updated = kustomization.replace(
    /(-\s*name:\s+registry\.ide-newton\.ts\.net\/lab\/sag\s*\n\s*newName:\s+registry\.ide-newton\.ts\.net\/lab\/sag\s*\n\s*newTag:\s*).*/,
    (_, prefix) => `${prefix}"${tag}"`,
  )

  if (updated === kustomization) {
    fatal(`Unable to update ${kustomizationPath}; image stanza changed`)
  }

  writeFileSync(kustomizationPath, updated)
  console.log(`Updated ${kustomizationPath} with tag ${tag}`)
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
