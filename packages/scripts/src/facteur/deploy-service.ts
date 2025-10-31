#!/usr/bin/env bun

import { readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { $ } from 'bun'
import { ensureCli, fatal, repoRoot } from '../shared/cli'
import { buildImage } from './build-image'

const execGit = (args: string[]): string => {
  const result = Bun.spawnSync(['git', ...args], { cwd: repoRoot })
  if (result.exitCode !== 0) {
    throw new Error(`git ${args.join(' ')} failed`)
  }
  return result.stdout.toString().trim()
}

export const main = async () => {
  ensureCli('kubectl')
  ensureCli('kn')

  const registry = process.env.FACTEUR_IMAGE_REGISTRY ?? 'registry.ide-newton.ts.net'
  const repository = process.env.FACTEUR_IMAGE_REPOSITORY ?? 'lab/facteur'
  const defaultTag = execGit(['rev-parse', '--short', 'HEAD'])
  const tag = process.env.FACTEUR_IMAGE_TAG ?? defaultTag
  const image = `${registry}/${repository}:${tag}`

  await buildImage({ registry, repository, tag })

  const digest = Bun.spawnSync(['docker', 'image', 'inspect', '--format', '{{index .RepoDigests 0}}', image], {
    cwd: repoRoot,
  })
  if (digest.exitCode !== 0) {
    throw new Error(`failed to inspect image ${image}: ${digest.stderr.toString()}`)
  }
  const repoDigest = digest.stdout.toString().trim()
  console.log(`Image digest: ${repoDigest}`)

  await updateManifests({ tag, rolloutTimestamp: new Date().toISOString() })

  const overlay = resolve(
    repoRoot,
    process.env.FACTEUR_KUSTOMIZE_PATH ?? 'argocd/applications/facteur/overlays/cluster',
  )
  await $`kubectl apply -k ${overlay}`

  const serviceManifest = resolve(
    repoRoot,
    process.env.FACTEUR_SERVICE_MANIFEST ?? 'argocd/applications/facteur/overlays/cluster/facteur-service.yaml',
  )
  await $`kn service apply facteur --namespace facteur --filename ${serviceManifest} --image ${image}`
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
    /(name:\s+registry\.ide-newton\.ts\.net\/lab\/facteur\s*\n\s*newTag:\s*)(.+)/,
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
