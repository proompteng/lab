#!/usr/bin/env bun

import { readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { ensureCli, fatal, repoRoot, run } from '../shared/cli'
import { inspectImageDigest } from '../shared/docker'
import { execGit } from '../shared/git'
import { buildImage } from './build-image'

const IMAGE_NAME = 'registry.ide-newton.ts.net/lab/reestr'

export const main = async () => {
  ensureCli('kubectl')

  const registry = process.env.REESTR_IMAGE_REGISTRY ?? 'registry.ide-newton.ts.net'
  const repository = process.env.REESTR_IMAGE_REPOSITORY ?? 'lab/reestr'
  const defaultTag = execGit(['rev-parse', '--short', 'HEAD'])
  const tag = process.env.REESTR_IMAGE_TAG ?? defaultTag
  const image = `${registry}/${repository}:${tag}`

  await buildImage({ registry, repository, tag })

  const repoDigest = inspectImageDigest(image)
  const digest = repoDigest.includes('@') ? repoDigest.split('@')[1] : repoDigest
  console.log(`Image digest: ${repoDigest}`)

  await updateManifests({ tag, digest, rolloutTimestamp: new Date().toISOString() })

  const kustomizePath = resolve(repoRoot, process.env.REESTR_KUSTOMIZE_PATH ?? 'argocd/applications/registry')
  await run('kubectl', ['apply', '-k', kustomizePath])
}

if (import.meta.main) {
  main().catch((error) => fatal('Failed to build and deploy reestr', error))
}

export const __private = {
  execGit,
}

type ManifestUpdateOptions = {
  tag: string
  digest?: string
  rolloutTimestamp: string
}

const escapeRegExp = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

function updateManifests(options: ManifestUpdateOptions) {
  const { tag, digest, rolloutTimestamp } = options

  const kustomizationPath = resolve(repoRoot, 'argocd/applications/registry/kustomization.yaml')
  const kustomization = readFileSync(kustomizationPath, 'utf8')
  const imagePattern = new RegExp(`(name:\\s+${escapeRegExp(IMAGE_NAME)}\\s*\\n\\s*newTag:\\s*)(.+)`, 'm')
  let updatedKustomization = kustomization.replace(imagePattern, (_, prefix) => `${prefix}"${tag}"`)

  if (digest) {
    const digestPattern = new RegExp(
      `(name:\\s+${escapeRegExp(IMAGE_NAME)}\\s*\\n\\s*newTag:\\s*[^\\n]+\\n\\s*digest:\\s*)(.+)`,
      'm',
    )
    if (digestPattern.test(updatedKustomization)) {
      updatedKustomization = updatedKustomization.replace(digestPattern, (_, prefix) => `${prefix}${digest}`)
    } else {
      updatedKustomization = updatedKustomization.replace(
        new RegExp(`(name:\\s+${escapeRegExp(IMAGE_NAME)}\\s*\\n\\s*newTag:\\s*[^\\n]+)`, 'm'),
        `$1\n    digest: ${digest}`,
      )
    }
  }

  if (kustomization === updatedKustomization) {
    console.warn('Warning: Reestr kustomization was not updated; pattern may have changed.')
  } else {
    writeFileSync(kustomizationPath, updatedKustomization)
    console.log(`Updated ${kustomizationPath} with tag ${tag}`)
  }

  const servicePath = resolve(repoRoot, 'argocd/applications/registry/reestr-knative-service.yaml')
  const service = readFileSync(servicePath, 'utf8')
  const rolloutPattern = /deploy\.knative\.dev\/rollout:\s*("[^"]*"|'[^']*'|[^\n]*)/
  const updatedService = service.replace(rolloutPattern, `deploy.knative.dev/rollout: "${rolloutTimestamp}"`)
  if (service === updatedService) {
    console.warn('Warning: Reestr service rollout annotation was not updated; pattern may have changed.')
  } else {
    writeFileSync(servicePath, updatedService)
    console.log(`Updated ${servicePath} rollout annotation to ${rolloutTimestamp}`)
  }
}
