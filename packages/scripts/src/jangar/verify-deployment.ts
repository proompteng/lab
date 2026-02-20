#!/usr/bin/env bun

import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import process from 'node:process'

import { ensureCli, fatal, repoRoot } from '../shared/cli'

type CliOptions = {
  namespace?: string
  deployments?: string[]
  kustomizationPath?: string
  imageName?: string
  argoNamespace?: string
  argoApplication?: string
  rolloutTimeout?: string
  healthAttempts?: number
  healthIntervalSeconds?: number
  requireSynced?: boolean
}

type CommandResult = {
  stdout: string
  stderr: string
  exitCode: number
}

const defaultImageName = 'registry.ide-newton.ts.net/lab/jangar'
const defaultKustomizationPath = 'argocd/applications/jangar/kustomization.yaml'
const defaultNamespace = 'jangar'
const defaultDeployments = ['jangar', 'jangar-worker']
const defaultArgoNamespace = 'argocd'
const defaultArgoApplication = 'jangar'
const defaultRolloutTimeout = '10m'
const defaultHealthAttempts = 60
const defaultHealthIntervalSeconds = 10

const resolvePath = (path: string) => resolve(repoRoot, path)

const stripYamlValueQuotes = (value: string): string => value.replace(/^['"]|['"]$/g, '')

export const extractExpectedDigest = (kustomizationSource: string, imageName: string): string => {
  const lines = kustomizationSource.split(/\r?\n/)
  let inImageBlock = false

  for (const line of lines) {
    const trimmed = line.trim()
    const nameMatch = trimmed.match(/^-?\s*name:\s*(.+)$/)
    if (nameMatch) {
      const candidate = stripYamlValueQuotes(nameMatch[1].trim())
      inImageBlock = candidate === imageName
      continue
    }

    if (!inImageBlock) {
      continue
    }

    const digestMatch = trimmed.match(/^digest:\s*(.+)$/)
    if (digestMatch) {
      const digest = stripYamlValueQuotes(digestMatch[1].trim())
      return digest.includes('@') ? digest.slice(digest.lastIndexOf('@') + 1) : digest
    }
  }

  throw new Error(`Unable to find digest for image '${imageName}' in kustomization`)
}

const runCommand = async (command: string, args: string[], allowFailure = false): Promise<CommandResult> => {
  const subprocess = Bun.spawn([command, ...args], {
    stdout: 'pipe',
    stderr: 'pipe',
  })

  const [stdout, stderr, exitCode] = await Promise.all([
    subprocess.stdout ? new Response(subprocess.stdout).text() : Promise.resolve(''),
    subprocess.stderr ? new Response(subprocess.stderr).text() : Promise.resolve(''),
    subprocess.exited,
  ])

  if (exitCode !== 0 && !allowFailure) {
    throw new Error(`Command failed (${exitCode}): ${command} ${args.join(' ')}\n${stderr || stdout}`.trim())
  }

  return { stdout, stderr, exitCode }
}

const parseArgs = (argv: string[]): CliOptions => {
  const options: CliOptions = {}

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    if (arg === '--help' || arg === '-h') {
      console.log(`Usage: bun run packages/scripts/src/jangar/verify-deployment.ts [options]

Options:
  --namespace <name>                 Kubernetes namespace (default: jangar)
  --deployments <name1,name2>        Deployments to verify (default: jangar,jangar-worker)
  --kustomization-path <path>        Kustomization path with expected digest
  --image-name <registry/repository> Image name in kustomization
  --argo-namespace <name>            Argo CD namespace (default: argocd)
  --argo-application <name>          Argo CD Application name (default: jangar)
  --rollout-timeout <duration>       kubectl rollout timeout (default: 10m)
  --health-attempts <number>         Argo health polling attempts (default: 60)
  --health-interval-seconds <number> Argo health polling interval seconds (default: 10)
  --require-synced                   Require Argo application sync status to be Synced`)
      process.exit(0)
    }

    if (arg === '--require-synced') {
      options.requireSynced = true
      continue
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
      case '--namespace':
        options.namespace = value
        break
      case '--deployments':
        options.deployments = value
          .split(',')
          .map((entry) => entry.trim())
          .filter(Boolean)
        break
      case '--kustomization-path':
        options.kustomizationPath = value
        break
      case '--image-name':
        options.imageName = value
        break
      case '--argo-namespace':
        options.argoNamespace = value
        break
      case '--argo-application':
        options.argoApplication = value
        break
      case '--rollout-timeout':
        options.rolloutTimeout = value
        break
      case '--health-attempts':
        options.healthAttempts = Number.parseInt(value, 10)
        break
      case '--health-interval-seconds':
        options.healthIntervalSeconds = Number.parseInt(value, 10)
        break
      default:
        throw new Error(`Unknown option: ${flag}`)
    }
  }

  return options
}

const waitForArgoHealth = async (options: Required<CliOptions>) => {
  for (let attempt = 1; attempt <= options.healthAttempts; attempt += 1) {
    const status = await runCommand(
      'kubectl',
      [
        '-n',
        options.argoNamespace,
        'get',
        'application',
        options.argoApplication,
        '-o',
        'jsonpath={.status.sync.status} {.status.health.status}',
      ],
      true,
    )

    if (status.exitCode !== 0) {
      const message = (status.stderr || status.stdout || '').trim()
      console.log(`Unable to query Argo application status (${message}); continuing with deployment verification`)
      return
    }

    const [syncStatus = 'unknown', healthStatus = 'unknown'] = status.stdout.trim().split(/\s+/)
    console.log(`Attempt ${attempt}: sync=${syncStatus} health=${healthStatus}`)

    if (healthStatus !== 'Healthy') {
      await Bun.sleep(options.healthIntervalSeconds * 1000)
      continue
    }

    if (options.requireSynced && syncStatus !== 'Synced') {
      throw new Error(
        `Argo application ${options.argoApplication} is Healthy but sync=${syncStatus} (require-synced is enabled)`,
      )
    }

    if (syncStatus !== 'Synced') {
      console.log(`Application is Healthy but sync=${syncStatus}; continuing with rollout/digest verification`)
    }
    return
  }

  throw new Error(`Argo application ${options.argoApplication} did not become Healthy within timeout`)
}

const verifyRollouts = async (namespace: string, deployments: string[], rolloutTimeout: string) => {
  for (const deployment of deployments) {
    await runCommand('kubectl', [
      'rollout',
      'status',
      `deployment/${deployment}`,
      '-n',
      namespace,
      `--timeout=${rolloutTimeout}`,
    ])
  }
}

const verifyDeploymentDigests = async (namespace: string, deployments: string[], expectedDigest: string) => {
  for (const deployment of deployments) {
    const deploymentImages = await runCommand('kubectl', [
      '-n',
      namespace,
      'get',
      'deployment',
      deployment,
      '-o',
      'jsonpath={..image}',
    ])
    const images = deploymentImages.stdout.trim()
    console.log(`${deployment} images: ${images}`)

    if (!images.includes(expectedDigest)) {
      throw new Error(`Deployment ${deployment} image digest does not include expected digest ${expectedDigest}`)
    }
  }
}

export const main = async (cliOptions?: CliOptions) => {
  ensureCli('kubectl')

  const parsed = cliOptions ?? parseArgs(process.argv.slice(2))
  const resolvedOptions: Required<CliOptions> = {
    namespace: parsed.namespace ?? defaultNamespace,
    deployments: parsed.deployments?.length ? parsed.deployments : [...defaultDeployments],
    kustomizationPath: parsed.kustomizationPath ?? defaultKustomizationPath,
    imageName: parsed.imageName ?? defaultImageName,
    argoNamespace: parsed.argoNamespace ?? defaultArgoNamespace,
    argoApplication: parsed.argoApplication ?? defaultArgoApplication,
    rolloutTimeout: parsed.rolloutTimeout ?? defaultRolloutTimeout,
    healthAttempts: parsed.healthAttempts ?? defaultHealthAttempts,
    healthIntervalSeconds: parsed.healthIntervalSeconds ?? defaultHealthIntervalSeconds,
    requireSynced: parsed.requireSynced ?? false,
  }

  if (!Number.isInteger(resolvedOptions.healthAttempts) || resolvedOptions.healthAttempts <= 0) {
    throw new Error(`healthAttempts must be a positive integer, received ${resolvedOptions.healthAttempts}`)
  }
  if (!Number.isInteger(resolvedOptions.healthIntervalSeconds) || resolvedOptions.healthIntervalSeconds <= 0) {
    throw new Error(
      `healthIntervalSeconds must be a positive integer, received ${resolvedOptions.healthIntervalSeconds}`,
    )
  }

  const kustomizationPath = resolvePath(resolvedOptions.kustomizationPath)
  const kustomizationSource = readFileSync(kustomizationPath, 'utf8')
  const expectedDigest = extractExpectedDigest(kustomizationSource, resolvedOptions.imageName)

  console.log(`Expected digest: ${expectedDigest}`)
  await waitForArgoHealth(resolvedOptions)
  await verifyRollouts(resolvedOptions.namespace, resolvedOptions.deployments, resolvedOptions.rolloutTimeout)
  await verifyDeploymentDigests(resolvedOptions.namespace, resolvedOptions.deployments, expectedDigest)
}

if (import.meta.main) {
  main().catch((error) => fatal('Failed to verify jangar deployment rollout', error))
}

export const __private = {
  extractExpectedDigest,
  parseArgs,
}
