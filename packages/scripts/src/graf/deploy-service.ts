#!/usr/bin/env bun

import { readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import YAML from 'yaml'

import { ensureCli, repoRoot, run } from '../shared/cli'
import { buildImage } from './build-image'

const manifestPath = resolve(repoRoot, 'argocd/applications/graf/knative-service.yaml')

const ensureResources = () => {
  ensureCli('docker')
  ensureCli('kn')
}

const getImageDigest = (image: string): string => {
  const inspect = Bun.spawnSync(['docker', 'image', 'inspect', '--format', '{{index .RepoDigests 0}}', image], {
    cwd: repoRoot,
  })

  if (inspect.exitCode !== 0) {
    throw new Error(`Failed to inspect image ${image}: ${inspect.stderr.toString().trim()}`)
  }

  const digest = inspect.stdout.toString().trim()
  if (!digest) {
    throw new Error(`Unable to resolve digest for image ${image}`)
  }

  return digest
}

const updateManifestImage = (image: string, version: string, commit: string) => {
  const existing = readFileSync(manifestPath, 'utf8')
  const doc = YAML.parse(existing)

  const containers:
    | Array<{ name?: string; image?: string; env?: Array<{ name?: string; value?: string }> }>
    | undefined = doc?.spec?.template?.spec?.containers ?? undefined
  if (!containers || containers.length === 0) {
    throw new Error('Unable to locate Graf container in knative-service manifest')
  }

  const target =
    containers.find((container) => container?.name === 'user-container') ??
    containers.find((container) => container?.name) ??
    containers[0]

  if (!target) {
    throw new Error('Unable to resolve target container for Graf manifest')
  }

  target.image = image

  target.env ??= []
  const env = target.env
  const ensureEnvEntry = (name: string, value: string) => {
    const existing = env.find((entry: { name?: string }) => entry?.name === name)
    if (existing) {
      existing.value = value
    } else {
      env.push({ name, value })
    }
  }
  ensureEnvEntry('GRAF_VERSION', version)
  ensureEnvEntry('GRAF_COMMIT', commit)

  doc.spec ??= {}
  doc.spec.template ??= {}
  doc.spec.template.metadata ??= {}
  doc.spec.template.metadata.annotations ??= {}
  doc.spec.template.metadata.annotations['client.knative.dev/updateTimestamp'] = new Date().toISOString()

  const updated = YAML.stringify(doc, { lineWidth: 120 })
  writeFileSync(manifestPath, updated)

  console.log(`Updated ${manifestPath} with image ${image}`)
}

const applyManifest = async () => {
  const rawTimeout = process.env.GRAF_KN_WAIT_TIMEOUT ?? '300s'
  const waitTimeout = rawTimeout.replace(/s$/, '')
  await run('kn', [
    'service',
    'apply',
    'graf',
    '--namespace',
    'graf',
    '--filename',
    manifestPath,
    '--wait',
    '--wait-timeout',
    waitTimeout,
  ])
  console.log('Applied Graf Knative service manifest via kn service apply (waited for readiness)')
}

const deploy = async () => {
  ensureResources()

  const { image, version, commit } = await buildImage()
  const digestRef = getImageDigest(image)

  updateManifestImage(digestRef, version, commit)
  await applyManifest()

  console.log(
    'Graf deployment updated. Commit the manifest change so Argo CD/Knative keep the service in sync with the new image.',
  )
}

if (import.meta.main) {
  deploy().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error))
    process.exit(1)
  })
}
