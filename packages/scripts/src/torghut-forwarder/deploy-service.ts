#!/usr/bin/env bun

import { readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { ensureCli, fatal, repoRoot, run } from '../shared/cli'
import { inspectImageDigest } from '../shared/docker'
import { execGit } from '../shared/git'
import { buildImage } from './build-image'

const deploymentPath = resolve(repoRoot, 'argocd/applications/torghut/forwarder/deployment.yaml')

const updateDeploymentImage = (image: string) => {
  const contents = readFileSync(deploymentPath, 'utf8')
  const updated = contents.replace(/(image:\s+).+/, `$1${image}`)
  if (contents === updated) {
    console.warn('Deployment image not updated; pattern may need adjustment')
  } else {
    writeFileSync(deploymentPath, updated)
    console.log(`Updated deployment image to ${image}`)
  }
}

const applyKustomization = async () => {
  const path = resolve(repoRoot, 'argocd/applications/torghut/forwarder')
  await run('kubectl', ['apply', '-k', path])
  await run('kubectl', ['-n', 'torghut', 'rollout', 'status', 'deploy/torghut-forwarder', '--timeout=180s'])
}

export const main = async () => {
  ensureCli('kubectl')
  ensureCli('docker')

  const registry = process.env.TORGHUT_FORWARDER_REGISTRY ?? 'registry.ide-newton.ts.net'
  const repository = process.env.TORGHUT_FORWARDER_REPOSITORY ?? 'lab/torghut-forwarder'
  const tag = process.env.TORGHUT_FORWARDER_TAG ?? execGit(['rev-parse', '--short', 'HEAD'])
  const image = `${registry}/${repository}:${tag}`

  const { version, commit } = await buildImage({ registry, repository, tag })
  const digest = inspectImageDigest(image)
  console.log(`Built ${image} (${digest}) version=${version} commit=${commit}`)

  updateDeploymentImage(image)
  await applyKustomization()
}

if (import.meta.main) {
  main().catch((error) => fatal('Failed to deploy torghut-forwarder', error))
}

export const __private = {
  updateDeploymentImage,
}
