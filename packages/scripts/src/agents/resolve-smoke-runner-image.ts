#!/usr/bin/env bun

import { appendFileSync } from 'node:fs'
import process from 'node:process'

import { fatal } from '../shared/cli'

const registry = 'registry.ide-newton.ts.net'
const repository = 'lab/agents-smoke-runner'
const smokeRunnerRepository = `${registry}/${repository}`
export const localSmokeRunnerImage = `${smokeRunnerRepository}:nix`

const shaPattern = /^[0-9a-f]{40}$/
const digestPattern = /^sha256:[0-9a-f]{64}$/

export const assertSmokeRunnerImage = (image: string) => {
  if (image === localSmokeRunnerImage) return
  const publishedPrefix = `${smokeRunnerRepository}:sha-`
  const [sha = '', digest = '', extra] = image.slice(publishedPrefix.length).split('@')
  if (
    !image.startsWith(publishedPrefix) ||
    !shaPattern.test(sha) ||
    !digestPattern.test(digest) ||
    extra !== undefined
  ) {
    throw new Error(
      `AGENTS_SMOKE_RUNNER_IMAGE must be ${localSmokeRunnerImage} or a digest-pinned ${smokeRunnerRepository} image.`,
    )
  }
}

type SmokeRunnerSource = { mode: 'local' } | { mode: 'published'; sourceSha: string }
type FetchManifest = (url: string, init: RequestInit) => Promise<Response>

export const resolveSmokeRunnerImage = async (source: SmokeRunnerSource, fetchManifest: FetchManifest = fetch) => {
  const local = { image: localSmokeRunnerImage, buildLocal: true }
  if (source.mode === 'local') return local
  if (!shaPattern.test(source.sourceSha)) {
    throw new Error('Published Agents values must contain a full source SHA to select the smoke runner.')
  }

  const tag = `sha-${source.sourceSha}`
  const reference = `${smokeRunnerRepository}:${tag}`
  const response = await fetchManifest(`https://${registry}/v2/${repository}/manifests/${tag}`, {
    headers: {
      Accept: 'application/vnd.oci.image.index.v1+json, application/vnd.docker.distribution.manifest.list.v2+json',
    },
    redirect: 'error',
    signal: AbortSignal.timeout(30_000),
  })
  if (response.status === 404) {
    const body = (await response.json().catch(() => null)) as { errors?: { code?: string }[] } | null
    // A proxy 404 is not evidence that the registry is missing this tag.
    if (
      Array.isArray(body?.errors) &&
      body.errors.length > 0 &&
      body.errors.every((error) => error?.code === 'MANIFEST_UNKNOWN' || error?.code === 'NAME_UNKNOWN')
    ) {
      return local
    }
  }
  if (response.status !== 200) {
    throw new Error(`Unable to resolve ${reference}: registry returned HTTP ${response.status}.`)
  }

  const digest = response.headers.get('Docker-Content-Digest')
  if (!digest || !digestPattern.test(digest)) {
    throw new Error(`Registry returned no valid Docker-Content-Digest for ${reference}.`)
  }
  return { image: `${reference}@${digest}`, buildLocal: false }
}

const main = async () => {
  const [mode, sourceSha = ''] = process.argv.slice(2)
  if (mode !== 'local' && mode !== 'published') {
    throw new Error('Expected smoke runner source: local or published <source-sha>.')
  }
  const selection = await resolveSmokeRunnerImage(mode === 'local' ? { mode } : { mode, sourceSha })
  if (mode === 'published' && selection.buildLocal) {
    console.log(`Smoke runner tag sha-${sourceSha} is missing; building the slim image from checkout.`)
  }
  const output = `image=${selection.image}\nbuild_local=${selection.buildLocal}\n`
  if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, output)
  console.log(output.trimEnd())
}

if (import.meta.main) {
  await main().catch((error) => fatal('Failed to select the Agents lifecycle smoke runner', error))
}
