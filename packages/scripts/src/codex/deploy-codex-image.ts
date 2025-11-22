#!/usr/bin/env bun
import { readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'

import { runBuildCodexImage } from '../../../../apps/froussard/src/codex/cli/build-codex-image'
import { ensureCli, fatal, repoRoot, run } from '../shared/cli'
import { inspectImageDigest } from '../shared/docker'
import { execGit } from '../shared/git'

type DeployOptions = {
  registry: string
  repository: string
  tag?: string
  apply: boolean
  dryRun: boolean
  manifests: string[]
}

const defaultManifests = [
  'argocd/applications/froussard/github-codex-planning-workflow-template.yaml',
  'argocd/applications/froussard/github-codex-review-workflow-template.yaml',
  'argocd/applications/froussard/github-codex-implementation-workflow-template.yaml',
  'argocd/applications/facteur/overlays/cluster/facteur-workflowtemplate.yaml',
  'argocd/applications/argo-workflows/codex-research-workflow.yaml',
]

const escapeRegExp = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

const replaceImageReferences = (content: string, registry: string, repository: string, newImage: string) => {
  const pattern = new RegExp(
    `${escapeRegExp(registry)}/${escapeRegExp(repository)}(?::[\\w.-]+)?(?:@sha256:[a-f0-9]+)?`,
    'g',
  )
  return content.replace(pattern, newImage)
}

const updateManifests = (
  manifests: string[],
  registry: string,
  repository: string,
  newImage: string,
  dryRun: boolean,
) => {
  let updatedCount = 0
  for (const manifest of manifests) {
    const path = resolve(repoRoot, manifest)
    const original = readFileSync(path, 'utf8')
    const rewritten = replaceImageReferences(original, registry, repository, newImage)
    if (rewritten !== original) {
      updatedCount += 1
      if (!dryRun) {
        writeFileSync(path, rewritten)
      }
      console.log(`${dryRun ? 'Would update' : 'Updated'} ${manifest} to ${newImage}`)
    } else {
      console.warn(`No image reference replaced in ${manifest}`)
    }
  }
  return updatedCount
}

const parseArgs = (argv: string[]): DeployOptions => {
  const options: DeployOptions = {
    registry: process.env.CODEX_IMAGE_REGISTRY ?? 'registry.ide-newton.ts.net',
    repository: process.env.CODEX_IMAGE_REPOSITORY ?? 'lab/codex-universal',
    tag: process.env.CODEX_IMAGE_TAG,
    apply: argv.includes('--apply'),
    dryRun: argv.includes('--dry-run'),
    manifests: defaultManifests,
  }

  for (const arg of argv) {
    if (arg.startsWith('--tag=')) {
      options.tag = arg.slice('--tag='.length)
    } else if (arg.startsWith('--registry=')) {
      options.registry = arg.slice('--registry='.length)
    } else if (arg.startsWith('--repository=')) {
      options.repository = arg.slice('--repository='.length)
    }
  }

  return options
}

export const main = async (argv: string[]) => {
  ensureCli('docker')

  const options = parseArgs(argv)
  const tag = options.tag ?? execGit(['rev-parse', '--short', 'HEAD'])
  const imageRef = `${options.registry}/${options.repository}:${tag}`

  process.env.IMAGE_TAG = imageRef

  const { imageTag } = await runBuildCodexImage()
  const builtImage = imageTag ?? imageRef
  const digestRef = inspectImageDigest(builtImage)

  updateManifests(options.manifests, options.registry, options.repository, digestRef, options.dryRun)

  if (options.apply && !options.dryRun) {
    await run('kubectl', ['apply', '-k', 'argocd/applications/froussard'])
  }
}

if (import.meta.main) {
  main(process.argv.slice(2)).catch((error) => fatal('Failed to build and deploy Codex image', error))
}

export const __private = {
  defaultManifests,
  escapeRegExp,
  replaceImageReferences,
}
