#!/usr/bin/env bun

import { appendFileSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import process from 'node:process'

import { fatal, repoRoot } from '../shared/cli'
import { execGit } from '../shared/git'
import { readReleaseContract } from './release-contract'

const defaultContractPath = '.artifacts/jangar/release-contract.json'
const defaultImage = 'registry.ide-newton.ts.net/lab/jangar'

const buildTriggerPathRegex =
  /^(services\/jangar\/|services\/bumba\/|packages\/(agent-contracts|codex|cx-tools|design|discord|otel|temporal-bun-sdk)\/|nix\/images\/jangar\.nix$|nix\/images\/openai-codex-cli\.nix$|nix\/images\/bun-workspace-service\.nix$|nix\/packages\.nix$|nix\/cache-push\.sh$|nix\/ci-nix-oci-summary\.sh$|nix\/ci-run-timed\.sh$|nix\/oci-inspect-archive\.sh$|nix\/oci-push\.sh$|nix\/oci-release-contract\.sh$|flake\.lock$|bun\.lock$|tsconfig\.base\.json$)/

type CliOptions = {
  eventName?: string
  workflowRunHeadSha?: string
  commitShaInput?: string
  imageTagInput?: string
  contractPath?: string
  image?: string
  outputPath?: string
}

type WorkflowRunStalenessInput = {
  sourceSha: string
  mainHead: string
  isAncestor: boolean
  changedMainFiles: string[]
}

type WorkflowRunStalenessDecision = {
  promote: boolean
  reason: string
}

type ResolveReleaseMetadataOptions = {
  eventName: string
  workflowRunHeadSha?: string
  commitShaInput?: string
  imageTagInput?: string
  contractPath: string
  image: string
}

export type ReleaseMetadata = {
  mainHead: string
  sourceSha: string
  tag: string
  contractDigest: string
  image: string
  promote: boolean
  reason: string
}

const resolvePath = (path: string) => resolve(repoRoot, path)

const normalizeEventName = (value: string): 'workflow_run' | 'workflow_dispatch' => {
  if (value === 'workflow_run' || value === 'workflow_dispatch') {
    return value
  }
  throw new Error(`Unsupported event '${value}'. Expected workflow_run or workflow_dispatch`)
}

const isBuildTriggerPath = (filePath: string): boolean => buildTriggerPathRegex.test(filePath)

const listChangedFilesBetween = (sourceSha: string, mainHead: string): string[] => {
  if (sourceSha === mainHead) {
    return []
  }
  const diff = execGit(['diff', '--name-only', `${sourceSha}..${mainHead}`])
  if (!diff) {
    return []
  }
  return diff
    .split('\n')
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0)
}

const isAncestorCommit = (ancestor: string, descendant: string): boolean => {
  const result = Bun.spawnSync(['git', 'merge-base', '--is-ancestor', ancestor, descendant], {
    cwd: repoRoot,
    stdout: 'pipe',
    stderr: 'pipe',
  })
  if (result.exitCode === 0) {
    return true
  }
  if (result.exitCode === 1) {
    return false
  }

  const stderr = result.stderr.toString().trim()
  throw new Error(
    `git merge-base --is-ancestor ${ancestor} ${descendant} failed (exit ${result.exitCode})${stderr ? `: ${stderr}` : ''}`,
  )
}

const commitExists = (sha: string): boolean => {
  const result = Bun.spawnSync(['git', 'cat-file', '-e', `${sha}^{commit}`], {
    cwd: repoRoot,
    stdout: 'ignore',
    stderr: 'ignore',
  })
  return result.exitCode === 0
}

const assertReleaseContractIdentity = (path: string) => {
  const parsed = JSON.parse(readFileSync(resolvePath(path), 'utf8')) as {
    service?: unknown
    packageAttr?: unknown
  }
  if (typeof parsed.service === 'string' && parsed.service !== 'jangar') {
    throw new Error(`Release contract service mismatch: expected jangar, got ${parsed.service}`)
  }
  if (typeof parsed.packageAttr === 'string' && parsed.packageAttr !== 'jangar-image') {
    throw new Error(`Release contract packageAttr mismatch: expected jangar-image, got ${parsed.packageAttr}`)
  }
}

const evaluateWorkflowRunStaleness = (input: WorkflowRunStalenessInput): WorkflowRunStalenessDecision => {
  if (input.sourceSha === input.mainHead) {
    return { promote: true, reason: 'head-current' }
  }
  if (!input.isAncestor) {
    return { promote: false, reason: 'source-not-ancestor' }
  }
  if (input.changedMainFiles.some((filePath) => isBuildTriggerPath(filePath))) {
    return { promote: false, reason: 'newer-main-has-jangar-changes' }
  }
  return { promote: true, reason: 'newer-main-non-jangar-only' }
}

const parseArgs = (argv: string[]): CliOptions => {
  const options: CliOptions = {}

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    if (arg === '--help' || arg === '-h') {
      console.log(`Usage: bun run packages/scripts/src/jangar/resolve-release-metadata.ts [options]

Options:
  --event-name <workflow_run|workflow_dispatch>
  --workflow-run-head-sha <sha40>
  --commit-sha-input <sha40>
  --image-tag-input <tag>
  --contract-path <path>
  --image <registry/repo>
  --output <path>

Defaults:
  contract-path: ${defaultContractPath}
  image: ${defaultImage}

Output keys:
  main_head, source_sha, tag, contract_digest, image, promote, promotion_reason`)
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
      case '--event-name':
        options.eventName = value
        break
      case '--workflow-run-head-sha':
        options.workflowRunHeadSha = value
        break
      case '--commit-sha-input':
        options.commitShaInput = value
        break
      case '--image-tag-input':
        options.imageTagInput = value
        break
      case '--contract-path':
        options.contractPath = value
        break
      case '--image':
        options.image = value
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

const resolveReleaseMetadata = (options: ResolveReleaseMetadataOptions): ReleaseMetadata => {
  const eventName = normalizeEventName(options.eventName)
  const mainHead = execGit(['rev-parse', 'origin/main'])

  let sourceSha = ''
  let tag = ''
  let contractDigest = ''
  let promote = true
  let reason = 'eligible'

  if (eventName === 'workflow_run') {
    assertReleaseContractIdentity(options.contractPath)
    const contract = readReleaseContract(options.contractPath)
    sourceSha = contract.sourceSha
    tag = contract.tag
    contractDigest = contract.digest

    if (contract.image !== options.image) {
      throw new Error(`Release contract image mismatch: expected ${options.image}, got ${contract.image}`)
    }

    const workflowRunHeadSha = options.workflowRunHeadSha?.trim() ?? ''
    if (!workflowRunHeadSha) {
      throw new Error('workflow_run requires --workflow-run-head-sha')
    }

    if (sourceSha !== workflowRunHeadSha) {
      throw new Error(`Release contract source SHA ${sourceSha} does not match workflow_run head ${workflowRunHeadSha}`)
    }

    const stalenessDecision = evaluateWorkflowRunStaleness({
      sourceSha,
      mainHead,
      isAncestor: isAncestorCommit(sourceSha, mainHead),
      changedMainFiles: listChangedFilesBetween(sourceSha, mainHead),
    })
    promote = stalenessDecision.promote
    reason = stalenessDecision.reason
  } else {
    sourceSha = options.commitShaInput?.trim() || mainHead
    tag = options.imageTagInput?.trim() || sourceSha.slice(0, 8)
    reason = 'manual-or-dispatch'
  }

  if (promote && !commitExists(sourceSha)) {
    throw new Error(`Source SHA ${sourceSha} is not present in local git history`)
  }

  return {
    mainHead,
    sourceSha,
    tag,
    contractDigest,
    image: options.image,
    promote,
    reason,
  }
}

const toGitHubOutputLines = (metadata: ReleaseMetadata): string[] => [
  `main_head=${metadata.mainHead}`,
  `source_sha=${metadata.sourceSha}`,
  `tag=${metadata.tag}`,
  `contract_digest=${metadata.contractDigest}`,
  `image=${metadata.image}`,
  `promote=${metadata.promote ? 'true' : 'false'}`,
  `promotion_reason=${metadata.reason}`,
]

const emitGitHubOutputs = (metadata: ReleaseMetadata, outputPath?: string) => {
  const lines = toGitHubOutputLines(metadata)
  if (outputPath) {
    appendFileSync(resolvePath(outputPath), `${lines.join('\n')}\n`, 'utf8')
    return
  }
  console.log(lines.join('\n'))
}

export const main = (cliOptions?: CliOptions) => {
  const parsed = cliOptions ?? parseArgs(process.argv.slice(2))
  const eventName = parsed.eventName ?? process.env.EVENT_NAME
  if (!eventName) {
    throw new Error('Missing event name. Provide --event-name or EVENT_NAME.')
  }

  const metadata = resolveReleaseMetadata({
    eventName,
    workflowRunHeadSha: parsed.workflowRunHeadSha ?? process.env.WORKFLOW_RUN_HEAD_SHA,
    commitShaInput: parsed.commitShaInput ?? process.env.COMMIT_SHA_INPUT,
    imageTagInput: parsed.imageTagInput ?? process.env.IMAGE_TAG_INPUT,
    contractPath: parsed.contractPath ?? defaultContractPath,
    image: parsed.image ?? defaultImage,
  })

  if (!metadata.promote) {
    console.log(
      `Skipping stale workflow_run promotion for ${metadata.sourceSha}; reason=${metadata.reason}; latest main is ${metadata.mainHead}`,
    )
  }

  emitGitHubOutputs(metadata, parsed.outputPath ?? process.env.GITHUB_OUTPUT)
}

if (import.meta.main) {
  try {
    main()
  } catch (error) {
    fatal('Failed to resolve jangar release metadata', error)
  }
}

export const __private = {
  assertReleaseContractIdentity,
  buildTriggerPathRegex,
  commitExists,
  evaluateWorkflowRunStaleness,
  isAncestorCommit,
  isBuildTriggerPath,
  listChangedFilesBetween,
  normalizeEventName,
  parseArgs,
  resolveReleaseMetadata,
  toGitHubOutputLines,
}
