#!/usr/bin/env bun

import { readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'

import { ensureCli, fatal, repoRoot, run } from '../shared/cli'
import { inspectImageDigest } from '../shared/docker'
import { execGit } from '../shared/git'
import { applyKnativeServiceImage } from '../shared/kn'
import { buildImage } from './build-image'

type DeployOptions = {
  registry?: string
  repository?: string
  tag?: string
  kustomizePath?: string
  serviceManifest?: string
}

const updateManifests = (
  kustomizePath: string,
  servicePath: string,
  tag: string,
  digest: string | undefined,
  rolloutTimestamp: string,
) => {
  const kustomization = readFileSync(kustomizePath, 'utf8')
  let updatedKustomization = kustomization.replace(
    /(name:\s+registry\.ide-newton\.ts\.net\/lab\/jangar\s*\n\s*newTag:\s*)(.+)/,
    (_, prefix) => `${prefix}${tag}`,
  )

  if (digest) {
    const digestPattern =
      /(name:\s+registry\.ide-newton\.ts\.net\/lab\/jangar\s*\n\s*newTag:\s*[^\n]+\n\s*digest:\s*)(.+)/
    if (digestPattern.test(updatedKustomization)) {
      updatedKustomization = updatedKustomization.replace(digestPattern, (_, prefix) => `${prefix}${digest}`)
    } else {
      updatedKustomization = updatedKustomization.replace(
        /(name:\s+registry\.ide-newton\.ts\.net\/lab\/jangar\s*\n\s*newTag:\s*[^\n]+)/,
        `$1\n    digest: ${digest}`,
      )
    }
  }
  if (kustomization === updatedKustomization) {
    console.warn('Warning: jangar kustomization was not updated; pattern may have changed.')
  } else {
    writeFileSync(kustomizePath, updatedKustomization)
    console.log(`Updated ${kustomizePath} with tag ${tag}`)
  }

  const service = readFileSync(servicePath, 'utf8')
  const updatedService = service.replace(/(deploy\.knative\.dev\/rollout:\s*").+("?)/, `$1${rolloutTimestamp}$2`)
  if (service === updatedService) {
    console.warn('Warning: jangar service rollout annotation was not updated; pattern may have changed.')
  } else {
    writeFileSync(servicePath, updatedService)
    console.log(`Updated ${servicePath} rollout annotation to ${rolloutTimestamp}`)
  }
}

export const main = async (options: DeployOptions = {}) => {
  ensureCli('kubectl')

  const registry = options.registry ?? process.env.JANGAR_IMAGE_REGISTRY ?? 'registry.ide-newton.ts.net'
  const repository = options.repository ?? process.env.JANGAR_IMAGE_REPOSITORY ?? 'lab/jangar'
  const defaultTag = execGit(['rev-parse', '--short', 'HEAD'])
  const tag = options.tag ?? process.env.JANGAR_IMAGE_TAG ?? defaultTag
  const image = `${registry}/${repository}:${tag}`

  await buildImage({ registry, repository, tag })

  const repoDigest = inspectImageDigest(image)
  console.log(`Image digest: ${repoDigest}`)

  const kustomizePath = resolve(
    repoRoot,
    options.kustomizePath ?? process.env.JANGAR_KUSTOMIZE_PATH ?? 'argocd/applications/jangar',
  )
  const serviceManifest = resolve(
    repoRoot,
    options.serviceManifest ?? process.env.JANGAR_SERVICE_MANIFEST ?? 'argocd/applications/jangar/kservice.yaml',
  )

  // Persist image tag and rollout marker in Git before applying
  updateManifests(`${kustomizePath}/kustomization.yaml`, serviceManifest, tag, repoDigest, new Date().toISOString())

  await run('kubectl', ['apply', '-k', kustomizePath])
  await applyKnativeServiceImage('jangar', 'jangar', serviceManifest, image)
}

if (import.meta.main) {
  main().catch((error) => fatal('Failed to build and deploy jangar', error))
}

export const __private = { execGit, updateManifests }
