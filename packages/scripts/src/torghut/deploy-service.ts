#!/usr/bin/env bun

import { readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import YAML from 'yaml'
import { ensureCli, fatal, repoRoot, run } from '../shared/cli'
import { inspectImageDigest } from '../shared/docker'
import { buildImage } from './build-image'

const manifestPath = resolve(repoRoot, 'argocd/applications/torghut/knative-service.yaml')

const ensureTools = () => {
  ensureCli('docker')
  ensureCli('kn')
}

const updateManifest = (image: string, version: string, commit: string) => {
  const raw = readFileSync(manifestPath, 'utf8')
  const doc = YAML.parse(raw)

  const containers:
    | Array<{ name?: string; image?: string; env?: Array<{ name?: string; value?: string }> }>
    | undefined = doc?.spec?.template?.spec?.containers

  if (!containers || containers.length === 0) {
    throw new Error('Unable to locate torghut container in manifest')
  }

  const container = containers.find((item) => item?.name === 'user-container') ?? containers[0]
  container.image = image
  container.env ??= []

  const ensureEnv = (name: string, value: string) => {
    const existing = container.env?.find((entry) => entry?.name === name)
    if (existing) {
      existing.value = value
    } else {
      container.env?.push({ name, value })
    }
  }

  ensureEnv('TORGHUT_VERSION', version)
  ensureEnv('TORGHUT_COMMIT', commit)

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
  const waitTimeout = process.env.TORGHUT_KN_WAIT_TIMEOUT ?? '300'
  await run('kn', [
    'service',
    'apply',
    'torghut',
    '--namespace',
    'torghut',
    '--filename',
    manifestPath,
    '--wait',
    '--wait-timeout',
    waitTimeout,
  ])
}

const main = async () => {
  ensureTools()

  const { image, version, commit } = await buildImage()
  const digestRef = inspectImageDigest(image)

  updateManifest(digestRef, version, commit)
  await applyManifest()

  console.log('torghut deployment updated; commit manifest changes for Argo CD reconciliation.')
}

if (import.meta.main) {
  main().catch((error) => fatal('Failed to deploy torghut', error))
}
