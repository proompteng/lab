#!/usr/bin/env bun

import { appendFileSync } from 'node:fs'

import { repoRoot } from '../shared/cli'
import { createOciIndex } from '../shared/oci'

const members = [
  { name: 'bayn', buildResult: 'BAYN_BUILD_RESULT', output: 'bayn_digest' },
  { name: 'bayn-research', buildResult: 'RESEARCH_BUILD_RESULT', output: 'research_digest' },
  { name: 'bayn-broker-feed', buildResult: 'BROKER_FEED_BUILD_RESULT', output: 'broker_feed_digest' },
] as const
const architectures = ['amd64', 'arm64'] as const
const registry = 'registry.ide-newton.ts.net/lab'
const publisher = 'https://github.com/proompteng/lab'

type BaynCohortDigests = {
  bayn_digest: string
  research_digest: string
  broker_feed_digest: string
}

const readCommand = (command: string, args: string[]): string => {
  const result = Bun.spawnSync([command, ...args], { cwd: repoRoot, stdin: 'ignore', stdout: 'pipe', stderr: 'pipe' })
  if (result.exitCode !== 0) throw new Error(`${command} ${args.join(' ')} failed with exit ${result.exitCode}`)
  return result.stdout.toString().trim()
}

const object = (value: unknown): Record<string, unknown> => {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new Error('Expected an OCI object')
  return value as Record<string, unknown>
}

const digest = (value: string | undefined, reference: string): string => {
  if (!value || !/^sha256:[0-9a-f]{64}$/.test(value)) throw new Error(`Missing or invalid OCI digest for ${reference}`)
  return value
}

const prepareBaynImageCohort = (environment: NodeJS.ProcessEnv): BaynCohortDigests => {
  if (
    environment.GITHUB_REPOSITORY !== 'proompteng/lab' ||
    environment.GITHUB_REF !== 'refs/heads/main' ||
    !['push', 'workflow_dispatch'].includes(environment.GITHUB_EVENT_NAME ?? '')
  )
    throw new Error('Bayn image cohort preparation requires a main publication in proompteng/lab')
  const source = environment.GITHUB_SHA ?? ''
  const runId = environment.GITHUB_RUN_ID ?? ''
  if (!/^[0-9a-f]{40}$/.test(source)) throw new Error('Bayn image cohort requires the exact source commit')
  if (!/^[1-9][0-9]*$/.test(runId)) throw new Error('Bayn image cohort requires a positive workflow run ID')
  for (const member of members) {
    if (environment[member.buildResult] !== 'success')
      throw new Error(`Both platform builds must succeed for ${member.name}`)
  }
  if (readCommand('git', ['rev-parse', 'HEAD']) !== source)
    throw new Error('Bayn image cohort checkout does not match its source commit')
  const timestamp = readCommand('git', ['show', '-s', '--format=%cI', 'HEAD'])
  if (!timestamp) throw new Error('Bayn image cohort requires the source commit timestamp')
  const tag = `sha-${source}`

  // Complete all six checks before creating even an undiscoverable preparation index.
  const prepared = members.map((member) => {
    const image = `${registry}/${member.name}`
    const platforms = architectures.map((architecture) => {
      const platformTag = `${image}:${tag}-${architecture}`
      const platformDigest = digest(readCommand('crane', ['digest', platformTag]), platformTag)
      const reference = `${image}@${platformDigest}`
      const parsed: unknown = JSON.parse(readCommand('crane', ['config', reference]))
      const config = object(parsed)
      const labels = object(object(config.config).Labels)
      if (config.os !== 'linux' || config.architecture !== architecture)
        throw new Error(`Unexpected platform for ${reference}`)
      if (
        labels['org.opencontainers.image.revision'] !== source ||
        labels['org.opencontainers.image.created'] !== timestamp
      ) {
        throw new Error(`Platform image does not match the source commit metadata: ${reference}`)
      }
      return { platform: `linux/${architecture}`, architecture, digest: platformDigest, reference }
    })
    return { member, image, platforms }
  })

  const outputs = new Map<string, string>()
  for (const { member, image, platforms } of prepared) {
    const result = createOciIndex({
      image,
      tag,
      archTags: platforms.map((platform) => ({ platform: platform.platform, tag: platform.reference })),
      annotations: {
        'org.opencontainers.image.source': publisher,
        'org.opencontainers.image.revision': source,
        'ai.proompteng.github-actions-run-id': runId,
        'ai.proompteng.github-actions-build-conclusion': 'success',
      },
      latest: false,
      kargoTag: `kargo-sha-${source}-run-${runId}`,
      deferKargoTag: true,
    })
    const indexDigest = digest(result.digest, image)
    const reference = `${image}@${indexDigest}`
    // Re-read by digest: a mutable preparation tag cannot substitute another child set between checks.
    const manifest = object(JSON.parse(readCommand('crane', ['manifest', reference])))
    const descriptors = manifest.manifests
    if (!Array.isArray(descriptors) || descriptors.length !== platforms.length)
      throw new Error(`Prepared index does not contain the verified platform digests: ${reference}`)
    // Do not use the general platform inspector here: it intentionally omits untyped descriptors.
    const observed = descriptors.map((entry) => {
      const descriptor = object(entry)
      const platform = object(descriptor.platform)
      return {
        digest: descriptor.digest,
        os: platform.os,
        architecture: platform.architecture,
        variant: platform.variant,
      }
    })
    if (
      platforms.some(
        (expected) =>
          observed.filter(
            (actual) =>
              actual.os === 'linux' &&
              actual.architecture === expected.architecture &&
              (actual.variant === undefined || actual.variant === '') &&
              actual.digest === expected.digest,
          ).length !== 1,
      )
    )
      throw new Error(`Prepared index does not contain the verified platform digests: ${reference}`)
    outputs.set(member.output, indexDigest)
  }
  return {
    bayn_digest: digest(outputs.get('bayn_digest'), 'bayn'),
    research_digest: digest(outputs.get('research_digest'), 'bayn-research'),
    broker_feed_digest: digest(outputs.get('broker_feed_digest'), 'bayn-broker-feed'),
  }
}

export const writeBaynImageCohortOutputs = (environment: NodeJS.ProcessEnv) => {
  const output = environment.GITHUB_OUTPUT
  if (!output) throw new Error('Bayn image cohort preparation requires GITHUB_OUTPUT')
  const digests = prepareBaynImageCohort(environment)
  // Never expose a partial set to the verification/artifact/discovery steps.
  appendFileSync(
    output,
    Object.entries(digests)
      .map(([name, value]) => `${name}=${value}\n`)
      .join(''),
  )
}

if (import.meta.main) writeBaynImageCohortOutputs(process.env)
