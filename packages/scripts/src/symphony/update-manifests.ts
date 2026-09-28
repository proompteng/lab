#!/usr/bin/env bun

import { readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import process from 'node:process'

import { fatal, repoRoot } from '../shared/cli'
import { inspectImageDigest } from '../shared/docker'
import { execGit } from '../shared/git'

const defaultRegistry = 'registry.ide-newton.ts.net'
const defaultRepository = 'lab/symphony'
const defaultManifestTargets = [
  {
    kustomizationPath: 'argocd/applications/symphony/kustomization.yaml',
    deploymentPath: 'argocd/applications/symphony/deployment.patch.yaml',
  },
  {
    kustomizationPath: 'argocd/applications/symphony-jangar/kustomization.yaml',
    deploymentPath: 'argocd/applications/symphony-jangar/deployment.patch.yaml',
  },
  {
    kustomizationPath: 'argocd/applications/symphony-torghut/kustomization.yaml',
    deploymentPath: 'argocd/applications/symphony-torghut/deployment.patch.yaml',
  },
] as const

export type UpdateManifestsOptions = {
  imageName: string
  tag: string
  digest?: string
  rolloutTimestamp: string
  kustomizationPaths?: string[]
  deploymentPaths?: string[]
}

type CliOptions = {
  registry?: string
  repository?: string
  tag?: string
  digest?: string
  rolloutTimestamp?: string
  kustomizationPaths?: string[]
  deploymentPaths?: string[]
}

const escapeRegExp = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
const resolvePath = (value: string) => resolve(repoRoot, value)

const normalizeDigest = (value: string): string => {
  const trimmed = value.trim()
  if (!trimmed) return trimmed
  return trimmed.includes('@') ? trimmed.slice(trimmed.lastIndexOf('@') + 1) : trimmed
}

const updateKustomizationManifest = (
  kustomizationPath: string,
  imageName: string,
  tag: string,
  digest: string,
): boolean => {
  const source = readFileSync(kustomizationPath, 'utf8')
  const quotedTag = JSON.stringify(tag)
  const imagePattern = new RegExp(
    `(name:\\s+${escapeRegExp(imageName)}\\s*\\n(?:\\s*newName:\\s+[^\\n]+\\n)?\\s*newTag:\\s*)(.+)`,
    'm',
  )
  let updated = source.replace(imagePattern, (_, prefix) => `${prefix}${quotedTag}`)
  const digestPattern = new RegExp(
    `(name:\\s+${escapeRegExp(imageName)}\\s*\\n(?:\\s*newName:\\s+[^\\n]+\\n)?\\s*newTag:\\s*[^\\n]+\\n\\s*digest:\\s*)(.+)`,
    'm',
  )
  if (digestPattern.test(updated)) {
    updated = updated.replace(digestPattern, (_, prefix) => `${prefix}${digest}`)
  } else {
    updated = updated.replace(
      new RegExp(`(name:\\s+${escapeRegExp(imageName)}\\s*\\n(?:\\s*newName:\\s+[^\\n]+\\n)?\\s*newTag:\\s*[^\\n]+)`),
      `$1\n    digest: ${digest}`,
    )
  }

  if (source === updated) {
    console.warn('Warning: symphony kustomization was not updated; pattern may have changed.')
    return false
  }

  writeFileSync(kustomizationPath, updated)
  console.log(`Updated ${kustomizationPath} with tag ${tag} and digest ${digest}`)
  return true
}

const updateRolloutAnnotation = (deploymentPath: string, rolloutTimestamp: string): boolean => {
  const source = readFileSync(deploymentPath, 'utf8')
  const updated = source.replace(/(kubectl\.kubernetes\.io\/restartedAt:\s*).*/, `$1"${rolloutTimestamp}"`)

  if (source === updated) {
    console.warn('Warning: symphony deployment rollout annotation was not updated; pattern may have changed.')
    return false
  }

  writeFileSync(deploymentPath, updated)
  console.log(`Updated ${deploymentPath} rollout annotation to ${rolloutTimestamp}`)
  return true
}

export const updateSymphonyManifests = (options: UpdateManifestsOptions) => {
  const digest = normalizeDigest(options.digest ?? inspectImageDigest(`${options.imageName}:${options.tag}`))
  const kustomizationPaths = (
    options.kustomizationPaths ?? defaultManifestTargets.map((target) => target.kustomizationPath)
  ).map((manifestPath) => resolvePath(manifestPath))
  const deploymentPaths = (
    options.deploymentPaths ?? defaultManifestTargets.map((target) => target.deploymentPath)
  ).map((manifestPath) => resolvePath(manifestPath))

  if (kustomizationPaths.length !== deploymentPaths.length) {
    throw new Error('kustomizationPaths and deploymentPaths must have the same length')
  }

  return {
    tag: options.tag,
    digest,
    rolloutTimestamp: options.rolloutTimestamp,
    changed: kustomizationPaths.map((kustomizationPath, index) => ({
      kustomizationPath,
      deploymentPath: deploymentPaths[index]!,
      kustomization: updateKustomizationManifest(kustomizationPath, options.imageName, options.tag, digest),
      deployment: updateRolloutAnnotation(deploymentPaths[index]!, options.rolloutTimestamp),
    })),
  }
}

const parseArgs = (argv: string[]): CliOptions => {
  const options: CliOptions = {}
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    if (arg === '--help' || arg === '-h') {
      console.log(`Usage: bun run packages/scripts/src/symphony/update-manifests.ts [options]

Options:
  --registry <value>
  --repository <value>
  --tag <value>
  --digest <value>
  --rollout-timestamp <ISO8601>
  --kustomization-path <path>   (repeatable)
  --deployment-path <path>      (repeatable)`)
      process.exit(0)
    }

    if (!arg.startsWith('--')) {
      throw new Error(`Unknown argument: ${arg}`)
    }

    const [flag, inlineValue] = arg.includes('=') ? arg.split(/=(.*)/s, 2) : [arg, undefined]
    const value = inlineValue ?? argv[index + 1]
    if (inlineValue === undefined) {
      index += 1
    }
    if (value === undefined) {
      throw new Error(`Missing value for ${flag}`)
    }

    switch (flag) {
      case '--registry':
        options.registry = value
        break
      case '--repository':
        options.repository = value
        break
      case '--tag':
        options.tag = value
        break
      case '--digest':
        options.digest = value
        break
      case '--rollout-timestamp':
        options.rolloutTimestamp = value
        break
      case '--kustomization-path':
        options.kustomizationPaths = [...(options.kustomizationPaths ?? []), value]
        break
      case '--deployment-path':
        options.deploymentPaths = [...(options.deploymentPaths ?? []), value]
        break
      default:
        throw new Error(`Unknown option: ${flag}`)
    }
  }

  return options
}

export const main = (cliOptions?: CliOptions) => {
  const parsed = cliOptions ?? parseArgs(process.argv.slice(2))
  const registry = parsed.registry ?? process.env.SYMPHONY_IMAGE_REGISTRY ?? defaultRegistry
  const repository = parsed.repository ?? process.env.SYMPHONY_IMAGE_REPOSITORY ?? defaultRepository
  const defaultTag = execGit(['rev-parse', '--short', 'HEAD'])
  const tag = parsed.tag ?? process.env.SYMPHONY_IMAGE_TAG ?? defaultTag
  const rolloutTimestamp = parsed.rolloutTimestamp ?? process.env.SYMPHONY_ROLLOUT_TIMESTAMP ?? new Date().toISOString()

  const result = updateSymphonyManifests({
    imageName: `${registry}/${repository}`,
    tag,
    digest: parsed.digest ?? process.env.SYMPHONY_IMAGE_DIGEST,
    rolloutTimestamp,
    kustomizationPaths: parsed.kustomizationPaths,
    deploymentPaths: parsed.deploymentPaths,
  })

  console.log(
    `Symphony manifest update complete (tag=${result.tag}, digest=${result.digest}, rollout=${result.rolloutTimestamp})`,
  )
}

if (import.meta.main) {
  try {
    main()
  } catch (error) {
    fatal('Failed to update Symphony manifests', error)
  }
}

export const __private = {
  normalizeDigest,
}
