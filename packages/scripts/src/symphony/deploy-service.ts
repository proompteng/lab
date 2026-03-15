#!/usr/bin/env bun

import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

import { ensureCli, fatal, repoRoot, run } from '../shared/cli'
import { inspectImageDigest } from '../shared/docker'
import { execGit } from '../shared/git'
import { buildImage } from './build-image'
import { updateSymphonyManifests } from './update-manifests'

const defaultDeployTargets = [
  {
    kustomizePath: 'argocd/applications/symphony',
    namespace: 'jangar',
    deploymentName: 'symphony',
  },
  {
    kustomizePath: 'argocd/applications/symphony-jangar',
    namespace: 'jangar',
    deploymentName: 'symphony-jangar',
  },
  {
    kustomizePath: 'argocd/applications/symphony-torghut',
    namespace: 'torghut',
    deploymentName: 'symphony-torghut',
  },
] as const

const resolveKustomizeNamespace = (kustomizePath: string) => {
  const envNamespace = process.env.SYMPHONY_K8S_NAMESPACE?.trim()
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

const resolveDeployTargets = () => {
  const overridePaths = process.env.SYMPHONY_KUSTOMIZE_PATHS?.trim()
  if (!overridePaths) {
    return defaultDeployTargets
  }

  return overridePaths
    .split(',')
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0)
    .map((kustomizePath) => ({
      kustomizePath,
      namespace: resolveKustomizeNamespace(resolve(repoRoot, kustomizePath)),
      deploymentName:
        process.env.SYMPHONY_K8S_DEPLOYMENT?.trim() ||
        (kustomizePath.includes('symphony-torghut')
          ? 'symphony-torghut'
          : kustomizePath.includes('symphony-jangar')
            ? 'symphony-jangar'
            : 'symphony'),
    }))
}

export const main = async () => {
  ensureCli('kubectl')

  const registry = process.env.SYMPHONY_IMAGE_REGISTRY ?? 'registry.ide-newton.ts.net'
  const repository = process.env.SYMPHONY_IMAGE_REPOSITORY ?? 'lab/symphony'
  const defaultTag = execGit(['rev-parse', '--short', 'HEAD'])
  const tag = process.env.SYMPHONY_IMAGE_TAG ?? defaultTag
  const image = `${registry}/${repository}:${tag}`

  await buildImage({ registry, repository, tag })

  const repoDigest = inspectImageDigest(image)
  console.log(`Image digest: ${repoDigest}`)

  updateSymphonyManifests({
    imageName: 'registry.ide-newton.ts.net/lab/symphony',
    tag,
    digest: repoDigest,
    rolloutTimestamp: new Date().toISOString(),
  })

  for (const target of resolveDeployTargets()) {
    const kustomizePath = resolve(repoRoot, target.kustomizePath)
    await run('kubectl', ['apply', '-k', kustomizePath])
    await run('kubectl', ['rollout', 'status', `deployment/${target.deploymentName}`, '-n', target.namespace])
  }
}

if (import.meta.main) {
  main().catch((error) => fatal('Failed to build and deploy symphony', error))
}

export const __private = {
  execGit,
}
