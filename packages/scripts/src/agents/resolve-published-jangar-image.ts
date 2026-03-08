#!/usr/bin/env bun

import { appendFileSync } from 'node:fs'
import { resolve } from 'node:path'
import process from 'node:process'

import { readReleaseContract } from '../jangar/release-contract'
import { fatal, repoRoot } from '../shared/cli'

const defaultContractPath = '.artifacts/jangar/jangar-release-contract.json'
const defaultControlPlaneImage = 'registry.ide-newton.ts.net/lab/jangar-control-plane'

type CliOptions = {
  contractPath?: string
  controlPlaneImage?: string
  outputPath?: string
}

export type PublishedJangarImageMetadata = {
  sourceSha: string
  imageRepository: string
  imageTag: string
  imageDigest: string
  imageRef: string
  digestSource: 'contract' | 'tag-resolution-needed'
}

const resolvePath = (path: string) => resolve(repoRoot, path)

const parseArgs = (argv: string[]): CliOptions => {
  const options: CliOptions = {}

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    if (arg === '--help' || arg === '-h') {
      console.log(`Usage: bun run packages/scripts/src/agents/resolve-published-jangar-image.ts [options]

Options:
  --contract-path <path>
  --control-plane-image <registry/repo>
  --output <path>

Defaults:
  contract-path: ${defaultContractPath}
  control-plane-image: ${defaultControlPlaneImage}

Output keys:
  source_sha, image_repository, image_tag, image_digest, image_ref, digest_source`)
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
      case '--contract-path':
        options.contractPath = value
        break
      case '--control-plane-image':
        options.controlPlaneImage = value
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

export const resolvePublishedJangarImage = (
  contractPath: string,
  fallbackControlPlaneImage = defaultControlPlaneImage,
): PublishedJangarImageMetadata => {
  const contract = readReleaseContract(contractPath)
  const imageRepository = contract.controlPlaneImage?.trim() || fallbackControlPlaneImage
  const imageDigest = contract.controlPlaneDigest?.trim() ?? ''

  return {
    sourceSha: contract.sourceSha,
    imageRepository,
    imageTag: contract.tag,
    imageDigest,
    imageRef: imageDigest ? `${imageRepository}@${imageDigest}` : `${imageRepository}:${contract.tag}`,
    digestSource: imageDigest ? 'contract' : 'tag-resolution-needed',
  }
}

const toGitHubOutputLines = (metadata: PublishedJangarImageMetadata): string[] => [
  `source_sha=${metadata.sourceSha}`,
  `image_repository=${metadata.imageRepository}`,
  `image_tag=${metadata.imageTag}`,
  `image_digest=${metadata.imageDigest}`,
  `image_ref=${metadata.imageRef}`,
  `digest_source=${metadata.digestSource}`,
]

const emitOutputs = (metadata: PublishedJangarImageMetadata, outputPath?: string) => {
  const lines = toGitHubOutputLines(metadata)
  if (outputPath) {
    appendFileSync(resolvePath(outputPath), `${lines.join('\n')}\n`, 'utf8')
    return
  }
  console.log(lines.join('\n'))
}

export const main = (cliOptions?: CliOptions) => {
  const parsed = cliOptions ?? parseArgs(process.argv.slice(2))
  const metadata = resolvePublishedJangarImage(
    parsed.contractPath ?? defaultContractPath,
    parsed.controlPlaneImage ?? defaultControlPlaneImage,
  )
  emitOutputs(metadata, parsed.outputPath ?? process.env.GITHUB_OUTPUT)
}

if (import.meta.main) {
  try {
    main()
  } catch (error) {
    fatal('Failed to resolve published Jangar image', error)
  }
}

export const __private = {
  parseArgs,
  toGitHubOutputLines,
}
