#!/usr/bin/env bun

import { readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'

import { ensureCli, fatal, repoRoot, run } from '../shared/cli'
import { inspectImageDigest } from '../shared/docker'
import { execGit } from '../shared/git'
import { buildImage } from './build-image'

type ManifestUpdateOptions = {
  tag: string
  digest: string
  rolloutTimestamp: string
  kustomizationPath?: string
  deploymentPath?: string
}

const escapeRegExp = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

const normalizeDigest = (digest: string): string => {
  const trimmed = digest.trim()
  if (!trimmed) return trimmed
  const atIndex = trimmed.lastIndexOf('@')
  return atIndex >= 0 ? trimmed.slice(atIndex + 1) : trimmed
}

export const updateSymphonyManifests = ({
  tag,
  digest,
  rolloutTimestamp,
  kustomizationPath: providedKustomizationPath,
  deploymentPath: providedDeploymentPath,
}: ManifestUpdateOptions) => {
  const imageName = 'registry.ide-newton.ts.net/lab/symphony'
  const normalizedDigest = normalizeDigest(digest)
  const kustomizationPath = resolve(
    repoRoot,
    providedKustomizationPath ?? 'argocd/applications/symphony/kustomization.yaml',
  )
  const kustomization = readFileSync(kustomizationPath, 'utf8')
  const quotedTag = JSON.stringify(tag)
  const imagePattern = new RegExp(
    `(name:\\s+${escapeRegExp(imageName)}\\s*\\n(?:\\s*newName:\\s+[^\\n]+\\n)?\\s*newTag:\\s*)(.+)`,
    'm',
  )
  let updatedKustomization = kustomization.replace(imagePattern, (_, prefix) => `${prefix}${quotedTag}`)
  const digestPattern = new RegExp(
    `(name:\\s+${escapeRegExp(imageName)}\\s*\\n(?:\\s*newName:\\s+[^\\n]+\\n)?\\s*newTag:\\s*[^\\n]+\\n\\s*digest:\\s*)(.+)`,
    'm',
  )
  if (digestPattern.test(updatedKustomization)) {
    updatedKustomization = updatedKustomization.replace(digestPattern, (_, prefix) => `${prefix}${normalizedDigest}`)
  } else {
    updatedKustomization = updatedKustomization.replace(
      new RegExp(`(name:\\s+${escapeRegExp(imageName)}\\s*\\n(?:\\s*newName:\\s+[^\\n]+\\n)?\\s*newTag:\\s*[^\\n]+)`),
      `$1\n    digest: ${normalizedDigest}`,
    )
  }
  if (kustomization === updatedKustomization) {
    console.warn('Warning: symphony kustomization was not updated; pattern may have changed.')
  } else {
    writeFileSync(kustomizationPath, updatedKustomization)
    console.log(`Updated ${kustomizationPath} with tag ${tag} and digest ${normalizedDigest}`)
  }

  const deploymentPath = resolve(repoRoot, providedDeploymentPath ?? 'argocd/applications/symphony/deployment.yaml')
  const deployment = readFileSync(deploymentPath, 'utf8')
  const updatedDeployment = deployment.replace(
    /(kubectl\.kubernetes\.io\/restartedAt:\s*).*/,
    `$1"${rolloutTimestamp}"`,
  )
  if (deployment === updatedDeployment) {
    console.warn('Warning: symphony deployment rollout annotation was not updated; pattern may have changed.')
  } else {
    writeFileSync(deploymentPath, updatedDeployment)
    console.log(`Updated ${deploymentPath} rollout annotation to ${rolloutTimestamp}`)
  }
}

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

  updateSymphonyManifests({ tag, digest: repoDigest, rolloutTimestamp: new Date().toISOString() })

  const kustomizePath = resolve(repoRoot, process.env.SYMPHONY_KUSTOMIZE_PATH ?? 'argocd/applications/symphony')
  await run('kubectl', ['apply', '-k', kustomizePath])
  const namespace = resolveKustomizeNamespace(kustomizePath)
  const deploymentName = process.env.SYMPHONY_K8S_DEPLOYMENT ?? 'symphony'
  await run('kubectl', ['rollout', 'status', `deployment/${deploymentName}`, '-n', namespace])
}

if (import.meta.main) {
  main().catch((error) => fatal('Failed to build and deploy symphony', error))
}

export const __private = {
  execGit,
  normalizeDigest,
}
