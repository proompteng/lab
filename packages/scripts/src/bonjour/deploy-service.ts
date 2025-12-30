#!/usr/bin/env bun

import { readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import YAML from 'yaml'

import { ensureCli, fatal, repoRoot, run } from '../shared/cli'
import { inspectImageDigest } from '../shared/docker'
import { execGit } from '../shared/git'
import { buildImage } from './build-image'

const defaultAppSetPath = 'argocd/applicationsets/cdk8s.yaml'
const defaultAppName = 'bonjour'

const updateApplicationSetImage = (appSetPath: string, appName: string, image: string) => {
  const raw = readFileSync(appSetPath, 'utf8')
  const doc = YAML.parse(raw)

  const generators: Array<{ list?: { elements?: Array<Record<string, unknown>> } }> = Array.isArray(
    doc?.spec?.generators,
  )
    ? doc.spec.generators
    : []

  const element = generators
    .flatMap((generator) => generator?.list?.elements ?? [])
    .find((entry) => entry && typeof entry === 'object' && (entry as { name?: string }).name === appName)

  if (!element) {
    throw new Error(`Unable to find ApplicationSet element named '${appName}' in ${appSetPath}`)
  }

  ;(element as { image?: string }).image = image

  const updated = YAML.stringify(doc, { lineWidth: 120 })
  writeFileSync(appSetPath, updated)
  console.log(`Updated ${appSetPath} with image ${image}`)
}

export const main = async () => {
  ensureCli('kubectl')

  const registry = process.env.BONJOUR_IMAGE_REGISTRY ?? 'registry.ide-newton.ts.net'
  const repository = process.env.BONJOUR_IMAGE_REPOSITORY ?? 'lab/bonjour'
  const defaultTag = execGit(['rev-parse', '--short', 'HEAD'])
  const tag = process.env.BONJOUR_IMAGE_TAG ?? defaultTag

  const { image } = await buildImage({ registry, repository, tag })

  const repoDigest = inspectImageDigest(image)
  console.log(`Image digest: ${repoDigest}`)

  const appSetPath = resolve(repoRoot, process.env.BONJOUR_APPSET_PATH ?? defaultAppSetPath)
  const appName = process.env.BONJOUR_APPSET_NAME ?? defaultAppName
  updateApplicationSetImage(appSetPath, appName, repoDigest)

  await run('kubectl', ['apply', '-f', appSetPath])

  console.log('bonjour ApplicationSet updated; commit manifest changes for Argo CD reconciliation.')
}

if (import.meta.main) {
  main().catch((error) => fatal('Failed to build and deploy bonjour', error))
}
