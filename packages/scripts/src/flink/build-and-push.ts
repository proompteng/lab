#!/usr/bin/env bun

import { readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { ensureCli, fatal, repoRoot, run } from '../shared/cli'
import { buildAndPushDockerImage, inspectImageDigest } from '../shared/docker'
import { execGit } from '../shared/git'

const SERVICE_ROOT = resolve(repoRoot, 'services/flink-kafka-roundtrip')
const DEPLOYMENT_PATH = resolve(repoRoot, 'argocd/applications/flink/overlays/cluster/flinkdeployment.yaml')

export const main = async () => {
  ensureCli('mvn')
  ensureCli('docker')

  const registry = process.env.FLINK_IMAGE_REGISTRY ?? 'registry.ide-newton.ts.net'
  const repository = process.env.FLINK_IMAGE_REPOSITORY ?? 'lab/flink-kafka-roundtrip'
  const tag = process.env.FLINK_IMAGE_TAG ?? execGit(['rev-parse', '--short', 'HEAD'])
  const dockerfile = process.env.FLINK_DOCKERFILE ?? 'services/flink-kafka-roundtrip/Dockerfile'

  await buildJar()

  const { image } = await buildAndPushDockerImage({
    registry,
    repository,
    tag,
    context: SERVICE_ROOT,
    dockerfile,
  })

  const repoDigest = inspectImageDigest(image)
  console.log(`Published ${image}`)
  console.log(`Digest: ${repoDigest}`)

  updateDeploymentImage(tag)
}

const buildJar = async () => {
  const pom = resolve(SERVICE_ROOT, 'pom.xml')
  await run('mvn', ['-f', pom, 'clean', 'package', '-DskipTests'], { cwd: SERVICE_ROOT })
}

const updateDeploymentImage = (tag: string) => {
  const deployment = readFileSync(DEPLOYMENT_PATH, 'utf8')
  const updated = deployment.replace(
    /(registry\.ide-newton\.ts\.net\/lab\/flink-kafka-roundtrip:)([\\w.-]+)/,
    (_, prefix) => `${prefix}${tag}`,
  )

  if (deployment === updated) {
    console.warn('Warning: flinkdeployment.yaml image tag was not updated; pattern may have changed.')
    return
  }

  writeFileSync(DEPLOYMENT_PATH, updated)
  console.log(`Updated Flink deployment image tag to ${tag}`)
}

if (import.meta.main) {
  main().catch((error) => fatal('Failed to build and push Flink job image', error))
}

export const __private = {
  buildJar,
  updateDeploymentImage,
}
