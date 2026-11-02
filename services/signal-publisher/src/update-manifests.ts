#!/usr/bin/env bun

import process from 'node:process'

import { NodeFileSystem, NodeRuntime } from '@effect/platform-node'
import { Effect, FileSystem, Logger } from 'effect'

const digestPattern = /^sha256:[0-9a-f]{64}$/
const sourceShaPattern = /^[0-9a-f]{40}$/
const tagPattern = /^[A-Za-z0-9._-]{1,128}$/

export interface ReleaseIdentity {
  readonly sourceSha: string
  readonly tag: string
  readonly digest: string
}

export interface SignalPublisherManifests {
  readonly kustomization: string
  readonly cronJob: string
}

interface UpdateFilesOptions extends ReleaseIdentity {
  readonly kustomizationPath: string
  readonly cronJobPath: string
}

const replaceExactlyOnce = (source: string, pattern: RegExp, replacement: string, name: string): string => {
  const matches = [...source.matchAll(new RegExp(pattern.source, `${pattern.flags.replace('g', '')}g`))]
  if (matches.length !== 1) throw new Error(`expected exactly one ${name}`)
  return source.replace(pattern, replacement)
}

const validateRelease = (release: ReleaseIdentity): void => {
  if (!sourceShaPattern.test(release.sourceSha)) throw new Error(`invalid source SHA: ${release.sourceSha}`)
  if (!tagPattern.test(release.tag)) throw new Error(`invalid image tag: ${release.tag}`)
  if (!digestPattern.test(release.digest)) throw new Error(`invalid image digest: ${release.digest}`)
}

export const updateSignalPublisherManifests = (
  release: ReleaseIdentity,
  manifests: SignalPublisherManifests,
): SignalPublisherManifests => {
  validateRelease(release)
  const imageBlock =
    /(  - name: registry\.ide-newton\.ts\.net\/lab\/signal-publisher\n    newName: registry\.ide-newton\.ts\.net\/lab\/signal-publisher\n    newTag: )[^\n]+(?:\n    digest: [^\n]+)?/
  const kustomization = replaceExactlyOnce(
    manifests.kustomization,
    imageBlock,
    `$1${JSON.stringify(release.tag)}\n    digest: ${release.digest}`,
    'Signal publisher image block',
  )

  const pinProvenance = (manifest: string, name: string): string => {
    const withRevision = replaceExactlyOnce(
      manifest,
      /(^[ \t]+- name: SIGNAL_CODE_REVISION\n[ \t]+value: )[^\n]+/m,
      `$1${JSON.stringify(release.sourceSha)}`,
      `${name} SIGNAL_CODE_REVISION value`,
    )
    return replaceExactlyOnce(
      withRevision,
      /(^[ \t]+- name: SIGNAL_IMAGE_DIGEST\n[ \t]+value: )[^\n]+/m,
      `$1${release.digest}`,
      `${name} SIGNAL_IMAGE_DIGEST value`,
    )
  }

  const cronJob = pinProvenance(manifests.cronJob, 'Signal publisher CronJob')
  return { kustomization, cronJob }
}

const updateFiles = (options: UpdateFilesOptions) =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem
    const [kustomization, cronJob] = yield* Effect.all([
      fileSystem.readFileString(options.kustomizationPath),
      fileSystem.readFileString(options.cronJobPath),
    ])
    const updated = yield* Effect.try(() => updateSignalPublisherManifests(options, { kustomization, cronJob }))
    yield* Effect.all([
      fileSystem.writeFileString(options.kustomizationPath, updated.kustomization),
      fileSystem.writeFileString(options.cronJobPath, updated.cronJob),
    ])
  })

const parseArguments = (argv: readonly string[]): UpdateFilesOptions => {
  const values = new Map<string, string>()
  const allowed = new Set(['--source-sha', '--tag', '--digest'])
  if (argv.length % 2 !== 0) throw new Error(`missing value for ${argv.at(-1)}`)
  for (let index = 0; index < argv.length; index += 2) {
    const flag = argv[index]
    const value = argv[index + 1]
    if (!flag || !allowed.has(flag) || !value) throw new Error(`invalid argument near ${flag ?? '<end>'}`)
    if (values.has(flag)) throw new Error(`duplicate argument: ${flag}`)
    values.set(flag, value)
  }
  const required = (flag: string): string => {
    const value = values.get(flag)?.trim()
    if (!value) throw new Error(`${flag} is required`)
    return value
  }
  return {
    sourceSha: required('--source-sha'),
    tag: required('--tag'),
    digest: required('--digest'),
    kustomizationPath: 'argocd/applications/torghut/clickhouse/kustomization.yaml',
    cronJobPath: 'argocd/applications/torghut/clickhouse/signal-publisher-cronjob.yaml',
  }
}

if (import.meta.main) {
  const program = Effect.try(() => parseArguments(process.argv.slice(2))).pipe(
    Effect.flatMap(updateFiles),
    Effect.tapError((error) =>
      Effect.logError('Signal publisher promotion failed').pipe(
        Effect.annotateLogs({ service: 'signal-publisher-release', error: error.message }),
      ),
    ),
    Effect.provide(NodeFileSystem.layer),
    Effect.provide(Logger.layer([Logger.consoleJson])),
  )
  NodeRuntime.runMain(program, { disableErrorReporting: true })
}
