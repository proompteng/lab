#!/usr/bin/env bun

import { readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import YAML from 'yaml'

import { ensureCli, fatal, repoRoot, run } from '../shared/cli'
import { inspectImageDigest } from '../shared/docker'
import { execGit } from '../shared/git'
import { buildImage } from './build-image'

const defaultKustomizePath = 'argocd/applications/discourse'
const defaultDeploymentManifest = 'argocd/applications/discourse/deployment.yaml'

const updateDeploymentManifest = (manifestPath: string, image: string) => {
  const raw = readFileSync(manifestPath, 'utf8')
  const doc = YAML.parse(raw)

  const containers: Array<{ name?: string; image?: string }> | undefined = doc?.spec?.template?.spec?.containers

  if (!containers || containers.length === 0) {
    throw new Error('Unable to locate discourse container in deployment manifest')
  }

  const container = containers.find((item) => item?.name === 'discourse') ?? containers[0]
  container.image = image

  const updated = YAML.stringify(doc, { lineWidth: 120 })
  writeFileSync(manifestPath, updated)
  console.log(`Updated ${manifestPath} with image ${image}`)
}

export const main = async () => {
  ensureCli('kubectl')

  const registry = process.env.DISCOURSE_IMAGE_REGISTRY ?? 'registry.ide-newton.ts.net'
  const repository = process.env.DISCOURSE_IMAGE_REPOSITORY ?? 'lab/discourse'
  const defaultTag = execGit(['rev-parse', '--short', 'HEAD'])
  const tag = process.env.DISCOURSE_IMAGE_TAG ?? defaultTag

  const { image } = await buildImage({ registry, repository, tag })

  const repoDigest = inspectImageDigest(image)
  console.log(`Image digest: ${repoDigest}`)

  const deploymentPath = resolve(repoRoot, process.env.DISCOURSE_DEPLOYMENT_MANIFEST ?? defaultDeploymentManifest)
  updateDeploymentManifest(deploymentPath, repoDigest)

  const kustomizePath = resolve(repoRoot, process.env.DISCOURSE_KUSTOMIZE_PATH ?? defaultKustomizePath)
  await run('kubectl', ['apply', '-k', kustomizePath])

  console.log('discourse deployment updated; commit manifest changes for Argo CD reconciliation.')
}

if (import.meta.main) {
  main().catch((error) => fatal('Failed to build and deploy discourse', error))
}
