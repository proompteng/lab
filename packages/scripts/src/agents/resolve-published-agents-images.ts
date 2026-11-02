#!/usr/bin/env bun

import { appendFileSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import process from 'node:process'

import YAML from 'yaml'

import { fatal, repoRoot } from '../shared/cli'

const defaultValuesPath = 'argocd/applications/agents/values.yaml'

type CliOptions = {
  valuesPath?: string
  outputPath?: string
}

type ImageValues = {
  repository: string
  tag: string
  digest: string
  ref: string
}

export type PublishedAgentsImagesMetadata = {
  sourceSha: string
  controlPlane: ImageValues
  controller: ImageValues
  runner: ImageValues
}

const resolvePath = (path: string) => resolve(repoRoot, path)

const asRecord = (value: unknown) =>
  value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : null

const asString = (value: unknown) => (typeof value === 'string' && value.trim().length > 0 ? value.trim() : '')

const parseArgs = (argv: string[]): CliOptions => {
  const options: CliOptions = {}

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    if (arg === '--help' || arg === '-h') {
      console.log(`Usage: bun run packages/scripts/src/agents/resolve-published-agents-images.ts [options]

Options:
  --values-path <path>
  --output <path>

Defaults:
  values-path: ${defaultValuesPath}

Output keys:
  source_sha,
  control_plane_image_repository, control_plane_image_tag, control_plane_image_digest, control_plane_image_ref,
  controller_image_repository, controller_image_tag, controller_image_digest, controller_image_ref,
  runner_image_repository, runner_image_tag, runner_image_digest, runner_image_ref`)
      process.exit(0)
    }

    if (!arg.startsWith('--')) {
      throw new Error(`Unknown argument: ${arg}`)
    }

    const [flag, inlineValue] = arg.includes('=') ? arg.split(/=(.*)/s, 2) : [arg, undefined]
    const value = inlineValue ?? argv[i + 1]
    if (inlineValue === undefined) {
      i += 1
    }
    if (value === undefined) {
      throw new Error(`Missing value for ${flag}`)
    }

    switch (flag) {
      case '--values-path':
        options.valuesPath = value
        break
      case '--output':
        options.outputPath = value
        break
      default:
        throw new Error(`Unknown option: ${flag}`)
    }
  }

  return options
}

const resolveImageValues = (
  rootImage: Record<string, unknown>,
  override: Record<string, unknown> | null,
  label: string,
): ImageValues => {
  const repository = asString(override?.repository) || asString(rootImage.repository)
  const tag = asString(override?.tag) || asString(rootImage.tag)
  const digest = asString(override?.digest) || asString(rootImage.digest)

  if (!repository) throw new Error(`${label}.image.repository is required`)
  if (!tag) throw new Error(`${label}.image.tag is required`)

  return {
    repository,
    tag,
    digest,
    ref: `${repository}:${tag}${digest ? `@${digest}` : ''}`,
  }
}

export const resolvePublishedAgentsImages = (valuesPath = defaultValuesPath): PublishedAgentsImagesMetadata => {
  const values = asRecord(YAML.parse(readFileSync(resolvePath(valuesPath), 'utf8')))
  if (!values) {
    throw new Error(`Agents values file did not parse to an object: ${valuesPath}`)
  }

  const rootImage = asRecord(values.image) ?? {}
  const controlPlane = asRecord(values.controlPlane)
  const controllers = asRecord(values.controllers)
  const runner = asRecord(values.runner)
  const controlPlaneImage = asRecord(controlPlane?.image)
  const controllerImage = asRecord(controllers?.image)
  const runnerImage = asRecord(runner?.image)
  const controlPlaneEnv = asRecord(asRecord(controlPlane?.env)?.vars)

  return {
    sourceSha:
      asString(controlPlaneEnv?.AGENTS_SOURCE_HEAD_SHA) ||
      asString(controlPlaneEnv?.AGENTS_GITOPS_REVISION) ||
      asString(controlPlaneImage?.tag) ||
      asString(rootImage.tag),
    controlPlane: resolveImageValues(rootImage, controlPlaneImage, 'controlPlane'),
    controller: resolveImageValues(rootImage, controllerImage, 'controllers'),
    runner: resolveImageValues(rootImage, runnerImage, 'runner'),
  }
}

const toGitHubOutputLines = (metadata: PublishedAgentsImagesMetadata): string[] => [
  `source_sha=${metadata.sourceSha}`,
  `control_plane_image_repository=${metadata.controlPlane.repository}`,
  `control_plane_image_tag=${metadata.controlPlane.tag}`,
  `control_plane_image_digest=${metadata.controlPlane.digest}`,
  `control_plane_image_ref=${metadata.controlPlane.ref}`,
  `controller_image_repository=${metadata.controller.repository}`,
  `controller_image_tag=${metadata.controller.tag}`,
  `controller_image_digest=${metadata.controller.digest}`,
  `controller_image_ref=${metadata.controller.ref}`,
  `runner_image_repository=${metadata.runner.repository}`,
  `runner_image_tag=${metadata.runner.tag}`,
  `runner_image_digest=${metadata.runner.digest}`,
  `runner_image_ref=${metadata.runner.ref}`,
]

const emitOutputs = (metadata: PublishedAgentsImagesMetadata, outputPath?: string) => {
  const lines = toGitHubOutputLines(metadata)
  if (outputPath) {
    appendFileSync(resolvePath(outputPath), `${lines.join('\n')}\n`, 'utf8')
    return
  }
  console.log(lines.join('\n'))
}

export const main = (cliOptions?: CliOptions) => {
  const parsed = cliOptions ?? parseArgs(process.argv.slice(2))
  const metadata = resolvePublishedAgentsImages(parsed.valuesPath ?? defaultValuesPath)
  emitOutputs(metadata, parsed.outputPath ?? process.env.GITHUB_OUTPUT)
}

if (import.meta.main) {
  try {
    main()
  } catch (error) {
    fatal('Failed to resolve published Agents images', error)
  }
}

export const __private = {
  parseArgs,
  toGitHubOutputLines,
}
