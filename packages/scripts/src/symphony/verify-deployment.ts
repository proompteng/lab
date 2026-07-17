#!/usr/bin/env bun

import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import process from 'node:process'

import { parseArgoApplicationStatus } from '../shared/argo'
import { ensureCli, fatal, repoRoot } from '../shared/cli'

type CliOptions = {
  namespace?: string
  deployment?: string
  containerName?: string
  kustomizationPath?: string
  imageName?: string
  argoNamespace?: string
  argoApplication?: string
  rolloutTimeout?: string
  healthAttempts?: number
  healthIntervalSeconds?: number
  expectedRevision?: string
  expectedRevisionMode?: 'exact' | 'ancestor'
  requireSynced?: boolean
  serviceBaseUrl?: string
}

type CommandResult = {
  stdout: string
  stderr: string
  exitCode: number
}

type KubernetesPodList = {
  items?: Array<{
    metadata?: { name?: string }
    spec?: {
      containers?: Array<{ name?: string; image?: string }>
    }
    status?: {
      containerStatuses?: Array<{ name?: string; imageID?: string; ready?: boolean }>
    }
  }>
}

type ResolvedOptions = {
  namespace: string
  deployment: string
  containerName: string
  kustomizationPath: string
  imageName: string
  argoNamespace: string
  argoApplication: string
  rolloutTimeout: string
  healthAttempts: number
  healthIntervalSeconds: number
  expectedRevision?: string
  expectedRevisionMode: 'exact' | 'ancestor'
  requireSynced: boolean
  serviceBaseUrl: string
}

const defaultNamespace = 'jangar'
const defaultDeployment = 'symphony'
const defaultContainerName = 'symphony'
const defaultKustomizationPath = 'argocd/applications/symphony/kustomization.yaml'
const defaultImageName = 'registry.ide-newton.ts.net/lab/symphony'
const defaultArgoNamespace = 'argocd'
const defaultArgoApplication = 'symphony'
const defaultRolloutTimeout = '10m'
const defaultHealthAttempts = 60
const defaultHealthIntervalSeconds = 10
const defaultServiceBaseUrl = 'http://symphony.jangar.svc.cluster.local:8080'
const shaPattern = /^[0-9a-f]{40}$/i
const supportedRevisionModes = ['exact', 'ancestor'] as const

const resolvePath = (value: string) => resolve(repoRoot, value)

const stripYamlValueQuotes = (value: string): string => value.replace(/^['"]|['"]$/g, '')

export const extractExpectedDigest = (kustomizationSource: string, imageName: string): string => {
  const lines = kustomizationSource.split(/\r?\n/)
  let inImageBlock = false

  for (const line of lines) {
    const trimmed = line.trim()
    const nameMatch = trimmed.match(/^-?\s*name:\s*(.+)$/)
    if (nameMatch) {
      inImageBlock = stripYamlValueQuotes(nameMatch[1].trim()) === imageName
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
  const subprocess = Bun.spawn([command, ...args], { stdout: 'pipe', stderr: 'pipe' })
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

const validateExpectedRevisionMode = (mode: string | undefined): 'exact' | 'ancestor' => {
  if (!mode) return 'exact'
  if (!supportedRevisionModes.includes(mode as (typeof supportedRevisionModes)[number])) {
    throw new Error(`Unknown --expected-revision-mode: ${mode}. Expected: ${supportedRevisionModes.join(', ')}`)
  }
  return mode as 'exact' | 'ancestor'
}

const isExpectedRevisionSatisfied = async (
  statusRevision: string,
  expectedRevision: string,
  mode: 'exact' | 'ancestor',
): Promise<boolean> => {
  if (!shaPattern.test(statusRevision) || !shaPattern.test(expectedRevision)) return false
  if (statusRevision === expectedRevision) return true
  if (mode === 'exact') return false

  const ancestry = await runCommand('git', ['merge-base', '--is-ancestor', expectedRevision, statusRevision], true)
  if (ancestry.exitCode === 0) return true
  if (ancestry.exitCode === 1) return false
  throw new Error(`Unable to validate revision ancestry: ${(ancestry.stderr || ancestry.stdout || '').trim()}`)
}

const parseArgs = (argv: string[]): CliOptions => {
  const options: CliOptions = {}

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    if (arg === '--help' || arg === '-h') {
      console.log(`Usage: bun run packages/scripts/src/symphony/verify-deployment.ts [options]

Options:
  --namespace <name>
  --deployment <name>
  --container-name <name>
  --kustomization-path <path>
  --image-name <registry/repository>
  --argo-namespace <name>
  --argo-application <name>
  --rollout-timeout <duration>
  --health-attempts <number>
  --health-interval-seconds <number>
  --expected-revision <sha>
  --expected-revision-mode <exact|ancestor>
  --require-synced
  --service-base-url <url>`)
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
    const value = inlineValue ?? argv[index + 1]
    if (inlineValue === undefined) {
      index += 1
    }
    if (value === undefined) {
      throw new Error(`Missing value for ${flag}`)
    }

    switch (flag) {
      case '--namespace':
        options.namespace = value
        break
      case '--deployment':
        options.deployment = value
        break
      case '--container-name':
        options.containerName = value
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
      case '--expected-revision':
        options.expectedRevision = value
        break
      case '--expected-revision-mode':
        options.expectedRevisionMode = value as 'exact' | 'ancestor'
        break
      case '--service-base-url':
        options.serviceBaseUrl = value
        break
      default:
        throw new Error(`Unknown option: ${flag}`)
    }
  }

  return options
}

const resolveOptions = (options: CliOptions): ResolvedOptions => ({
  namespace: options.namespace ?? defaultNamespace,
  deployment: options.deployment ?? defaultDeployment,
  containerName: options.containerName ?? defaultContainerName,
  kustomizationPath: resolvePath(options.kustomizationPath ?? defaultKustomizationPath),
  imageName: options.imageName ?? defaultImageName,
  argoNamespace: options.argoNamespace ?? defaultArgoNamespace,
  argoApplication: options.argoApplication ?? defaultArgoApplication,
  rolloutTimeout: options.rolloutTimeout ?? defaultRolloutTimeout,
  healthAttempts: options.healthAttempts ?? defaultHealthAttempts,
  healthIntervalSeconds: options.healthIntervalSeconds ?? defaultHealthIntervalSeconds,
  expectedRevision: options.expectedRevision?.trim() || undefined,
  expectedRevisionMode: validateExpectedRevisionMode(options.expectedRevisionMode),
  requireSynced: options.requireSynced ?? false,
  serviceBaseUrl: options.serviceBaseUrl ?? defaultServiceBaseUrl,
})

const sleep = (seconds: number) => new Promise((resolve) => setTimeout(resolve, seconds * 1000))

type RetryOptions = {
  attempts: number
  intervalSeconds: number
  sleepFn?: (seconds: number) => Promise<unknown>
  onRetry?: (attempt: number, error: Error) => void
}

export const retryOperation = async <T>(operation: () => Promise<T>, options: RetryOptions): Promise<T> => {
  const sleepFn = options.sleepFn ?? sleep
  let lastError: Error | undefined
  for (let attempt = 1; attempt <= options.attempts; attempt += 1) {
    try {
      return await operation()
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error))
      if (attempt === options.attempts) break
      options.onRetry?.(attempt, lastError)
      await sleepFn(options.intervalSeconds)
    }
  }
  throw lastError ?? new Error('Operation did not run because retry attempts were not positive')
}

const verifyArgoHealth = async (options: ResolvedOptions) => {
  for (let attempt = 1; attempt <= options.healthAttempts; attempt += 1) {
    const statusOutput = await runCommand('kubectl', [
      'get',
      'application',
      options.argoApplication,
      '-n',
      options.argoNamespace,
      '-o',
      'json',
    ])
    const status = parseArgoApplicationStatus(statusOutput.stdout)
    const revisionSatisfied = options.expectedRevision
      ? await isExpectedRevisionSatisfied(status.revision, options.expectedRevision, options.expectedRevisionMode)
      : true

    const healthy = status.healthStatus === 'Healthy'
    const synced = !options.requireSynced || status.syncStatus === 'Synced'

    if (healthy && synced && revisionSatisfied) {
      return status
    }

    if (attempt === options.healthAttempts) {
      throw new Error(
        `Argo application ${options.argoApplication} did not become healthy/synced in time (health=${status.healthStatus}, sync=${status.syncStatus}, revision=${status.revision})`,
      )
    }

    console.log(
      `Attempt ${attempt}: sync=${status.syncStatus} health=${status.healthStatus} revision=${status.revision} desired=${status.desiredRevision}`,
    )
    await sleep(options.healthIntervalSeconds)
  }
}

const verifyServiceHealth = async (serviceBaseUrl: string) => {
  const livezResponse = await fetch(new URL('/livez', serviceBaseUrl))
  if (!livezResponse.ok) {
    throw new Error(`/livez returned ${livezResponse.status}`)
  }

  const stateResponse = await fetch(new URL('/api/v1/state', serviceBaseUrl))
  if (!stateResponse.ok) {
    throw new Error(`/api/v1/state returned ${stateResponse.status}`)
  }

  const stateBody = (await stateResponse.json()) as { leader?: { isLeader?: boolean }; instance?: { name?: string } }
  if (stateBody.leader?.isLeader !== true) {
    throw new Error('Symphony state endpoint did not report leader.isLeader=true')
  }

  return stateBody
}

export const imageReferenceMatchesDigest = (imageReference: string, expectedDigest: string): boolean => {
  const normalizedImageReference = imageReference.trim()
  const normalizedDigest = expectedDigest.trim()
  return (
    normalizedImageReference === normalizedDigest ||
    normalizedImageReference.endsWith(`@${normalizedDigest}`) ||
    normalizedImageReference.endsWith(`://${normalizedDigest}`)
  )
}

export const selectReadyContainerImages = (
  podList: KubernetesPodList,
  containerName: string,
): Array<{ pod: string; image: string; imageID: string | null }> =>
  (podList.items ?? []).flatMap((pod) => {
    const image = (pod.spec?.containers ?? []).find((candidate) => candidate.name === containerName)?.image
    if (!image) return []
    return (pod.status?.containerStatuses ?? [])
      .filter((status) => status.name === containerName && status.ready === true)
      .map((status) => ({
        pod: pod.metadata?.name ?? 'unknown',
        image,
        imageID: status.imageID?.trim() || null,
      }))
  })

const verifyRunningDigest = async (options: ResolvedOptions, expectedDigest: string) => {
  const podsResult = await runCommand('kubectl', [
    'get',
    'pods',
    '-n',
    options.namespace,
    '-l',
    `app.kubernetes.io/name=${options.deployment}`,
    '-o',
    'json',
  ])
  const podList = JSON.parse(podsResult.stdout) as KubernetesPodList
  const runningImages = selectReadyContainerImages(podList, options.containerName)
  if (runningImages.length === 0) {
    throw new Error(
      `No ready '${options.containerName}' container image references were found for deployment ${options.deployment}`,
    )
  }
  const mismatches = runningImages.filter((status) => !imageReferenceMatchesDigest(status.image, expectedDigest))
  if (mismatches.length > 0) {
    throw new Error(
      `Running ${options.deployment} image digest does not match ${expectedDigest}: ${JSON.stringify(mismatches)}`,
    )
  }
  return runningImages
}

export const verifyDeployment = async (options: CliOptions = {}) => {
  ensureCli('kubectl')
  const resolved = resolveOptions(options)
  const expectedDigest = extractExpectedDigest(readFileSync(resolved.kustomizationPath, 'utf8'), resolved.imageName)

  await runCommand('kubectl', [
    'rollout',
    'status',
    `deployment/${resolved.deployment}`,
    '-n',
    resolved.namespace,
    `--timeout=${resolved.rolloutTimeout}`,
  ])

  const argoStatus = await verifyArgoHealth(resolved)
  const { runningImages, stateBody } = await retryOperation(
    async () => ({
      runningImages: await verifyRunningDigest(resolved, expectedDigest),
      stateBody: await verifyServiceHealth(resolved.serviceBaseUrl),
    }),
    {
      attempts: resolved.healthAttempts,
      intervalSeconds: resolved.healthIntervalSeconds,
      onRetry: (attempt, error) => {
        console.log(`Runtime convergence attempt ${attempt} failed for ${resolved.deployment}: ${error.message}`)
      },
    },
  )

  console.log(
    JSON.stringify(
      {
        namespace: resolved.namespace,
        deployment: resolved.deployment,
        containerName: resolved.containerName,
        argo: argoStatus,
        expectedDigest,
        runningImages,
        instance: stateBody.instance?.name ?? null,
      },
      null,
      2,
    ),
  )
}

export const main = async () => {
  await verifyDeployment(parseArgs(process.argv.slice(2)))
}

if (import.meta.main) {
  main().catch((error) => fatal('Failed to verify Symphony deployment', error))
}
