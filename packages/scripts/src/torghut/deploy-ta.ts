#!/usr/bin/env bun

import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import YAML from 'yaml'
import { ensureCli, fatal, repoRoot, run } from '../shared/cli'
import { buildTechnicalAnalysisImage } from './build-ta-image'

const taDeploymentPath = resolve(
  repoRoot,
  process.env.TORGHUT_TA_DEPLOYMENT_PATH ?? 'argocd/applications/torghut/ta/flinkdeployment.yaml',
)
const taKustomizePath = resolve(repoRoot, process.env.TORGHUT_TA_KUSTOMIZE_PATH ?? 'argocd/applications/torghut/ta')

const ensureTools = () => {
  ensureCli('nix')
  ensureCli('crane')
  ensureCli('kubectl')
  ensureCli('git')
}

const updateTechnicalAnalysisDeployment = (image: string, version: string, commit: string) => {
  if (!existsSync(taDeploymentPath)) {
    fatal(`Technical analysis deployment manifest not found at ${taDeploymentPath}; set TORGHUT_TA_DEPLOYMENT_PATH.`)
  }

  const raw = readFileSync(taDeploymentPath, 'utf8')
  const doc = YAML.parse(raw)

  doc.spec ??= {}
  doc.spec.image = image

  const containers:
    | Array<{ name?: string; image?: string; env?: Array<{ name?: string; value?: string }> }>
    | undefined = doc?.spec?.podTemplate?.spec?.containers

  if (!containers || containers.length === 0) {
    throw new Error('Unable to locate flink container in FlinkDeployment manifest')
  }

  const container = containers.find((item) => item?.name === 'flink-main-container') ?? containers[0]
  container.env ??= []

  const ensureEnv = (name: string, value: string) => {
    const existing = container.env?.find((entry) => entry?.name === name)
    if (existing) {
      existing.value = value
    } else {
      container.env?.push({ name, value })
    }
  }

  ensureEnv('TORGHUT_TA_VERSION', version)
  ensureEnv('TORGHUT_TA_COMMIT', commit)

  const updated = YAML.stringify(doc, { lineWidth: 120 })
  writeFileSync(taDeploymentPath, updated)
  console.log(`Updated ${taDeploymentPath} with image ${image}`)
}

const applyTechnicalAnalysisResources = async () => {
  if (!existsSync(taKustomizePath)) {
    fatal(`Technical analysis kustomize directory not found at ${taKustomizePath}; set TORGHUT_TA_KUSTOMIZE_PATH.`)
  }

  await run('kubectl', ['apply', '-k', taKustomizePath])
}

const main = async () => {
  ensureTools()
  const { digest, version, commit } = await buildTechnicalAnalysisImage()
  updateTechnicalAnalysisDeployment(digest, version, commit)
  await applyTechnicalAnalysisResources()
  console.log('torghut technical analysis deployment updated; commit manifest changes for Argo CD reconciliation.')
}

if (import.meta.main) {
  main().catch((error) => fatal('Failed to deploy torghut technical analysis', error))
}
