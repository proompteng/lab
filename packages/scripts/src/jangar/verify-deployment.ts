#!/usr/bin/env bun

import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import process from 'node:process'

import { parseArgoApplicationStatus, type ArgoApplicationStatus as ArgoStatus } from '../shared/argo'
import { ensureCli, fatal, repoRoot } from '../shared/cli'
import { extractImageDigestFromKustomizationSource } from './manifest-contract'

type CliOptions = {
  namespace?: string
  deployments?: string[]
  kustomizationPath?: string
  imageName?: string
  argoNamespace?: string
  argoApplication?: string
  statusServiceNamespace?: string
  statusServiceName?: string
  statusServicePort?: string
  controlPlaneStatusNamespace?: string
  admissionPassportConsumers?: AdmissionPassportConsumer[]
  rolloutTimeout?: string
  healthAttempts?: number
  healthIntervalSeconds?: number
  expectedRevision?: string
  expectedRevisionMode?: 'exact' | 'ancestor'
  digestAttempts?: number
  digestIntervalSeconds?: number
  requireSynced?: boolean
  skipAdmissionPassportVerification?: boolean
  skipRuntimeProofVerification?: boolean
  skipAuthorityProvenanceVerification?: boolean
}

type CommandResult = {
  stdout: string
  stderr: string
  exitCode: number
}

type CommandRunner = typeof runCommand

type ResolvedOptions = {
  namespace: string
  deployments: string[]
  kustomizationPath: string
  imageName: string
  argoNamespace: string
  argoApplication: string
  statusServiceNamespace: string
  statusServiceName: string
  statusServicePort: string
  controlPlaneStatusNamespace: string
  admissionPassportConsumers: AdmissionPassportConsumer[]
  rolloutTimeout: string
  healthAttempts: number
  healthIntervalSeconds: number
  expectedRevision?: string
  expectedRevisionMode: 'exact' | 'ancestor'
  digestAttempts: number
  digestIntervalSeconds: number
  requireSynced: boolean
  skipAdmissionPassportVerification: boolean
  skipRuntimeProofVerification: boolean
  skipAuthorityProvenanceVerification: boolean
  enforceAuthorityProvenanceDecisions: boolean
}

const defaultImageName = 'registry.ide-newton.ts.net/lab/jangar'
const defaultKustomizationPath = 'argocd/applications/jangar/kustomization.yaml'
const defaultNamespace = 'jangar'
const defaultDeployments = ['jangar']
const defaultArgoNamespace = 'argocd'
const defaultArgoApplication = 'jangar'
const defaultStatusServiceName = 'jangar'
const defaultStatusServicePort = '80'
const defaultControlPlaneStatusNamespace = 'agents'
const defaultRolloutTimeout = '10m'
const defaultHealthAttempts = 60
const defaultHealthIntervalSeconds = 10
const defaultDigestAttempts = 30
const defaultDigestIntervalSeconds = 10
const defaultRemoteBranch = 'main'
const ancestorFetchDepth = 1000
const shaPattern = /^[0-9a-f]{40}$/i
const supportedRevisionModes = ['exact', 'ancestor'] as const
type ExpectedRevisionMode = (typeof supportedRevisionModes)[number]
const supportedAdmissionPassportConsumers = ['serving', 'swarm_plan', 'swarm_implement', 'swarm_verify'] as const
type AdmissionPassportConsumer = (typeof supportedAdmissionPassportConsumers)[number]
const defaultAdmissionPassportConsumers: AdmissionPassportConsumer[] = [
  'serving',
  'swarm_plan',
  'swarm_implement',
  'swarm_verify',
]
const supportedAuthorityProvenanceSettlementStates = [
  'settled',
  'settled_with_split',
  'repairable_split',
  'hold',
  'block',
] as const
const supportedAuthorityProvenanceEvidenceModes = ['observe', 'shadow', 'hold', 'enforce'] as const
const supportedAuthorityProvenanceActionDecisions = ['allow', 'repair_only', 'hold', 'block'] as const

type RuntimeKitStatus = {
  runtime_kit_id?: unknown
  image_ref?: unknown
  component_digest?: unknown
  decision?: unknown
  fresh_until?: unknown
}

type AdmissionPassportStatus = {
  admission_passport_id?: unknown
  consumer_class?: unknown
  runtime_kit_set_digest?: unknown
  decision?: unknown
  required_runtime_kits?: unknown
  fresh_until?: unknown
  reason_codes?: unknown
}

type RecoveryWarrantExecutionClass = 'serving' | 'plan' | 'implement' | 'verify'

type RecoveryWarrantStatus = {
  recovery_warrant_id?: unknown
  execution_class?: unknown
  admission_passport_id?: unknown
  admitted_image_digest?: unknown
  runtime_kit_digest?: unknown
  required_proof_cell_ids?: unknown
  projection_watermark_ids?: unknown
  status?: unknown
  active_backlog_seat_count?: unknown
  reason_codes?: unknown
}

type RuntimeProofCellStatus = {
  runtime_proof_cell_id?: unknown
  recovery_warrant_id?: unknown
  status?: unknown
  required?: unknown
  expires_at?: unknown
  reason_codes?: unknown
}

type ProjectionWatermarkStatus = {
  projection_watermark_id?: unknown
  consumer_key?: unknown
  recovery_warrant_id?: unknown
  source_ref?: unknown
  projection_digest?: unknown
  status?: unknown
  expires_at?: unknown
  reason_codes?: unknown
}

type ControlPlaneStatusPayload = {
  runtime_kits?: unknown
  admission_passports?: unknown
  serving_passport_id?: unknown
  recovery_warrants?: unknown
  runtime_proof_cells?: unknown
  projection_watermarks?: unknown
  authority_provenance_settlement?: unknown
}

type AdmissionPassportParityEvidence = {
  consumers: AdmissionPassportConsumer[]
  passportIds: string[]
  runtimeKitSetDigests: string[]
  runtimeKitIds: string[]
  runtimeImageRefs: string[]
}

type RuntimeProofSurfaceParityEvidence = {
  consumers: AdmissionPassportConsumer[]
  warrantIds: string[]
  proofCellIds: string[]
  projectionWatermarkIds: string[]
}

type AuthorityProvenanceActionDecision = {
  action_class?: unknown
  decision?: unknown
  reason_codes?: unknown
}

type AuthorityProvenanceSettlementStatus = {
  schema_version?: unknown
  settlement_id?: unknown
  evidence_mode?: unknown
  settlement_state?: unknown
  winning_authority?: unknown
  fresh_until?: unknown
  action_class_decisions?: unknown
  reentry_windows?: unknown
  rollback_target?: unknown
  handoff_summary?: unknown
}

type AuthorityProvenanceEvidence = {
  settlementId: string
  evidenceMode: string
  settlementState: string
  winningAuthority: string
  deployWidenDecision: string
  mergeReadyDecision: string
  reentryWindowCount: number
}

const deploymentWarrantExecutionClassByConsumer: Record<AdmissionPassportConsumer, RecoveryWarrantExecutionClass> = {
  serving: 'serving',
  swarm_plan: 'plan',
  swarm_implement: 'implement',
  swarm_verify: 'verify',
}

const resolvePath = (path: string) => resolve(repoRoot, path)

const asRecord = (value: unknown): Record<string, unknown> | null =>
  value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : null

const asArray = (value: unknown): unknown[] => (Array.isArray(value) ? value : [])

const asString = (value: unknown): string | null => (typeof value === 'string' && value.trim() ? value.trim() : null)

const asBoolean = (value: unknown): boolean | null => (typeof value === 'boolean' ? value : null)

const asNumber = (value: unknown): number | null => (typeof value === 'number' && Number.isFinite(value) ? value : null)

const uniqueStrings = (values: string[]) => [...new Set(values)]

const stringList = (value: unknown) =>
  asArray(value)
    .map((entry) => asString(entry))
    .filter((entry): entry is string => Boolean(entry))

const reasonList = (value: unknown) => stringList(value).join(',') || 'none'

const parseBoolean = (value: string | undefined, fallback: boolean) => {
  const normalized = value?.trim().toLowerCase()
  if (!normalized) return fallback
  if (['1', 'true', 'yes', 'on', 'enabled'].includes(normalized)) return true
  if (['0', 'false', 'no', 'off', 'disabled'].includes(normalized)) return false
  return fallback
}

const parseAdmissionPassportConsumers = (value: string | undefined): AdmissionPassportConsumer[] | undefined => {
  if (!value) return undefined
  const consumers = value
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean)

  if (consumers.length === 0) {
    return []
  }

  for (const consumer of consumers) {
    if (!supportedAdmissionPassportConsumers.includes(consumer as AdmissionPassportConsumer)) {
      throw new Error(
        `Unknown admission passport consumer '${consumer}'. Expected: ${supportedAdmissionPassportConsumers.join(
          ', ',
        )}`,
      )
    }
  }

  return consumers as AdmissionPassportConsumer[]
}

const runtimeKitId = (kit: RuntimeKitStatus) => asString(kit.runtime_kit_id)
const admissionPassportConsumer = (passport: AdmissionPassportStatus) =>
  asString(passport.consumer_class) as AdmissionPassportConsumer | null

const parseFreshUntilMs = (value: unknown, context: string) => {
  const text = asString(value)
  if (!text) {
    throw new Error(`${context} does not include fresh_until`)
  }
  const parsed = Date.parse(text)
  if (Number.isNaN(parsed)) {
    throw new Error(`${context} has invalid fresh_until '${text}'`)
  }
  return parsed
}

const imageRefMatchesExpectedDigest = (imageRef: string, expectedDigest: string) =>
  imageRef === expectedDigest || imageRef.includes(`@${expectedDigest}`) || imageRef.endsWith(expectedDigest)

export const extractExpectedDigest = (kustomizationSource: string, imageName: string): string => {
  return extractImageDigestFromKustomizationSource(kustomizationSource, imageName)
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

const ensureRevisionAvailable = async (revision: string, runner: CommandRunner = runCommand): Promise<boolean> => {
  const existingCommit = await runner('git', ['cat-file', '-e', `${revision}^{commit}`], true)
  if (existingCommit.exitCode === 0) {
    return true
  }

  await runner('git', ['fetch', '--no-tags', '--depth=1', 'origin', revision], true)

  const fetchedCommit = await runner('git', ['cat-file', '-e', `${revision}^{commit}`], true)
  if (fetchedCommit.exitCode === 0) {
    return true
  }

  await runner('git', ['fetch', '--no-tags', 'origin', defaultRemoteBranch], true)

  const branchFetchedCommit = await runner('git', ['cat-file', '-e', `${revision}^{commit}`], true)
  return branchFetchedCommit.exitCode === 0
}

const deepenRevisionHistory = async (revision: string, runner: CommandRunner = runCommand): Promise<boolean> => {
  const deepenedRevision = await runner(
    'git',
    ['fetch', '--no-tags', `--deepen=${ancestorFetchDepth}`, 'origin', revision],
    true,
  )
  if (deepenedRevision.exitCode === 0) {
    return true
  }

  const branchFetchedRevision = await runner('git', ['fetch', '--no-tags', 'origin', defaultRemoteBranch], true)
  return branchFetchedRevision.exitCode === 0
}

const getArgoWaitReason = (
  status: ArgoStatus,
  options: ResolvedOptions,
  revisionSatisfied: boolean,
): string | undefined => {
  if (status.healthStatus !== 'Healthy') {
    return `health=${status.healthStatus}`
  }
  if (options.requireSynced && status.syncStatus !== 'Synced') {
    return `sync=${status.syncStatus}`
  }
  if (options.expectedRevision && !revisionSatisfied) {
    if (options.expectedRevisionMode === 'ancestor') {
      return `revision=${status.revision} is not a descendant of expected=${options.expectedRevision}`
    }
    return `revision=${status.revision} expected=${options.expectedRevision}`
  }

  return undefined
}

const isExpectedRevisionSatisfied = async (
  statusRevision: string,
  expectedRevision: string,
  mode: ExpectedRevisionMode,
  runner: CommandRunner = runCommand,
): Promise<boolean> => {
  if (!shaPattern.test(statusRevision) || !shaPattern.test(expectedRevision)) {
    return false
  }

  if (statusRevision === expectedRevision) {
    return true
  }

  if (mode === 'exact') {
    return false
  }

  const expectedAvailable = await ensureRevisionAvailable(expectedRevision, runner)
  const statusAvailable = await ensureRevisionAvailable(statusRevision, runner)
  if (!expectedAvailable || !statusAvailable) {
    return false
  }

  const ancestry = await runner('git', ['merge-base', '--is-ancestor', expectedRevision, statusRevision], true)
  if (ancestry.exitCode === 0) {
    return true
  }
  if (ancestry.exitCode === 1) {
    const historyAvailable = await deepenRevisionHistory(statusRevision, runner)
    if (!historyAvailable) {
      return false
    }

    const retriedAncestry = await runner('git', ['merge-base', '--is-ancestor', expectedRevision, statusRevision], true)
    return retriedAncestry.exitCode === 0
  }

  return false
}

const validateExpectedRevisionMode = (mode: string | undefined): ExpectedRevisionMode => {
  if (!mode) {
    return 'exact'
  }
  if (!supportedRevisionModes.includes(mode as ExpectedRevisionMode)) {
    throw new Error(`Unknown --expected-revision-mode: ${mode}. Expected: ${supportedRevisionModes.join(', ')}`)
  }
  return mode as ExpectedRevisionMode
}

const parseArgs = (argv: string[]): CliOptions => {
  const options: CliOptions = {}

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    if (arg === '--help' || arg === '-h') {
      console.log(`Usage: bun run packages/scripts/src/jangar/verify-deployment.ts [options]

Options:
  --namespace <name>                 Kubernetes namespace (default: jangar)
  --deployments <name1,name2>        Deployments to verify (default: jangar)
  --kustomization-path <path>        Kustomization path with expected digest
  --image-name <registry/repository> Image name in kustomization
  --argo-namespace <name>            Argo CD namespace (default: argocd)
  --argo-application <name>          Argo CD Application name (default: jangar)
  --status-service-namespace <name>  Namespace hosting the Jangar HTTP Service for status checks
  --status-service-name <name>       Jangar HTTP Service name for status checks (default: jangar)
  --status-service-port <port>       Jangar HTTP Service port for status checks (default: 80)
  --control-plane-status-namespace <name>
                                      Namespace passed to /api/control-plane/status (default: agents)
  --admission-passport-consumers <csv>
                                      Required passport consumers (default: ${defaultAdmissionPassportConsumers.join(',')})
  --skip-admission-passport-verification
                                      Skip runtime admission passport parity verification
  --skip-runtime-proof-verification
                                      Skip recovery warrant, runtime proof cell, and projection watermark verification
  --skip-authority-provenance-verification
                                      Skip authority provenance settlement verification
  --rollout-timeout <duration>       kubectl rollout timeout (default: 10m)
  --health-attempts <number>         Argo health polling attempts (default: 60)
  --health-interval-seconds <number> Argo health polling interval seconds (default: 10)
  --expected-revision <sha>          Require Argo app to be synced to this commit SHA
  --expected-revision-mode <mode>     Revision matching behavior when expectedRevision is set (exact|ancestor). default: exact
  --digest-attempts <number>         Digest polling attempts after rollout checks (default: 30)
  --digest-interval-seconds <number> Digest polling interval seconds (default: 10)
  --require-synced                   Require Argo application sync status to be Synced`)
      process.exit(0)
    }

    if (arg === '--require-synced') {
      options.requireSynced = true
      continue
    }
    if (arg === '--skip-admission-passport-verification') {
      options.skipAdmissionPassportVerification = true
      continue
    }
    if (arg === '--skip-runtime-proof-verification') {
      options.skipRuntimeProofVerification = true
      continue
    }
    if (arg === '--skip-authority-provenance-verification') {
      options.skipAuthorityProvenanceVerification = true
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
      case '--status-service-namespace':
        options.statusServiceNamespace = value
        break
      case '--status-service-name':
        options.statusServiceName = value
        break
      case '--status-service-port':
        options.statusServicePort = value
        break
      case '--control-plane-status-namespace':
        options.controlPlaneStatusNamespace = value
        break
      case '--admission-passport-consumers':
        options.admissionPassportConsumers = parseAdmissionPassportConsumers(value)
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
        options.expectedRevisionMode = value as CliOptions['expectedRevisionMode']
        break
      case '--digest-attempts':
        options.digestAttempts = Number.parseInt(value, 10)
        break
      case '--digest-interval-seconds':
        options.digestIntervalSeconds = Number.parseInt(value, 10)
        break
      default:
        throw new Error(`Unknown option: ${flag}`)
    }
  }

  return options
}

const waitForArgoState = async (options: ResolvedOptions) => {
  for (let attempt = 1; attempt <= options.healthAttempts; attempt += 1) {
    const status = await runCommand(
      'kubectl',
      ['-n', options.argoNamespace, 'get', 'application', options.argoApplication, '-o', 'json'],
      true,
    )

    if (status.exitCode !== 0) {
      const message = (status.stderr || status.stdout || '').trim()
      if (attempt === options.healthAttempts) {
        throw new Error(`Unable to query Argo application status: ${message}`)
      }
      console.log(`Attempt ${attempt}: unable to query Argo application status (${message})`)
      await Bun.sleep(options.healthIntervalSeconds * 1000)
      continue
    }

    const argoStatus = parseArgoApplicationStatus(status.stdout)
    const revisionSatisfied =
      !options.expectedRevision ||
      (await isExpectedRevisionSatisfied(argoStatus.revision, options.expectedRevision, options.expectedRevisionMode))
    console.log(
      `Attempt ${attempt}: sync=${argoStatus.syncStatus} health=${argoStatus.healthStatus} revision=${argoStatus.revision} desired=${argoStatus.desiredRevision}`,
    )

    const waitReason = getArgoWaitReason(argoStatus, options, revisionSatisfied)
    if (!waitReason) {
      return
    }
    if (attempt === options.healthAttempts) {
      throw new Error(
        `Argo application ${options.argoApplication} did not reach desired state within timeout (${waitReason})`,
      )
    }

    console.log(`Waiting for Argo application ${options.argoApplication}: ${waitReason}`)
    await Bun.sleep(options.healthIntervalSeconds * 1000)
  }
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

const readDeploymentImages = async (namespace: string, deployment: string): Promise<string> => {
  const deploymentImages = await runCommand('kubectl', [
    '-n',
    namespace,
    'get',
    'deployment',
    deployment,
    '-o',
    'jsonpath={..image}',
  ])

  return deploymentImages.stdout.trim()
}

const verifyDeploymentDigests = async (
  namespace: string,
  deployments: string[],
  expectedDigest: string,
  attempts: number,
  intervalSeconds: number,
) => {
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    const failedDeployments: string[] = []

    for (const deployment of deployments) {
      const images = await readDeploymentImages(namespace, deployment)
      console.log(`${deployment} images: ${images}`)

      if (!images.includes(expectedDigest)) {
        failedDeployments.push(`${deployment}=${images}`)
      }
    }

    if (failedDeployments.length === 0) {
      return
    }
    if (attempt === attempts) {
      throw new Error(
        `Deployment images do not include expected digest ${expectedDigest}: ${failedDeployments.join(' | ')}`,
      )
    }

    console.log(
      `Digest verification attempt ${attempt}/${attempts} failed; waiting ${intervalSeconds}s for deployment update`,
    )
    await Bun.sleep(intervalSeconds * 1000)
  }
}

const buildControlPlaneStatusProxyPath = (options: {
  statusServiceNamespace: string
  statusServiceName: string
  statusServicePort: string
  controlPlaneStatusNamespace: string
}) =>
  `/api/v1/namespaces/${options.statusServiceNamespace}/services/${options.statusServiceName}:${
    options.statusServicePort
  }/proxy/api/control-plane/status?namespace=${encodeURIComponent(options.controlPlaneStatusNamespace)}`

const readControlPlaneStatus = async (options: ResolvedOptions): Promise<ControlPlaneStatusPayload> => {
  const status = await runCommand('kubectl', [
    'get',
    '--raw',
    buildControlPlaneStatusProxyPath({
      statusServiceNamespace: options.statusServiceNamespace,
      statusServiceName: options.statusServiceName,
      statusServicePort: options.statusServicePort,
      controlPlaneStatusNamespace: options.controlPlaneStatusNamespace,
    }),
  ])

  const payload = asRecord(JSON.parse(status.stdout))
  if (!payload) {
    throw new Error('Control-plane status response was not a JSON object')
  }
  return payload as ControlPlaneStatusPayload
}

const verifyAdmissionPassportParity = (input: {
  status: ControlPlaneStatusPayload
  expectedDigest: string
  consumers: AdmissionPassportConsumer[]
  now?: Date
}): AdmissionPassportParityEvidence => {
  const nowMs = (input.now ?? new Date()).getTime()
  const runtimeKits = asArray(input.status.runtime_kits)
    .map((entry) => asRecord(entry) as RuntimeKitStatus | null)
    .filter((entry): entry is RuntimeKitStatus => Boolean(entry))
  const admissionPassports = asArray(input.status.admission_passports)
    .map((entry) => asRecord(entry) as AdmissionPassportStatus | null)
    .filter((entry): entry is AdmissionPassportStatus => Boolean(entry))

  if (runtimeKits.length === 0) {
    throw new Error('Control-plane status did not include runtime_kits')
  }
  if (admissionPassports.length === 0) {
    throw new Error('Control-plane status did not include admission_passports')
  }

  const runtimeKitById = new Map<string, RuntimeKitStatus>()
  for (const kit of runtimeKits) {
    const id = runtimeKitId(kit)
    if (id) runtimeKitById.set(id, kit)
  }

  const passportByConsumer = new Map<AdmissionPassportConsumer, AdmissionPassportStatus>()
  for (const passport of admissionPassports) {
    const consumer = admissionPassportConsumer(passport)
    if (consumer && supportedAdmissionPassportConsumers.includes(consumer)) {
      passportByConsumer.set(consumer, passport)
    }
  }

  const requiredRuntimeKitIds: string[] = []
  const passportIds: string[] = []
  const runtimeKitSetDigests: string[] = []

  for (const consumer of input.consumers) {
    const passport = passportByConsumer.get(consumer)
    if (!passport) {
      throw new Error(`Missing admission passport for consumer ${consumer}`)
    }

    const passportId = asString(passport.admission_passport_id)
    if (!passportId) {
      throw new Error(`Admission passport for consumer ${consumer} does not include admission_passport_id`)
    }
    if (consumer === 'serving' && asString(input.status.serving_passport_id) !== passportId) {
      throw new Error(
        `Serving passport mismatch: status.serving_passport_id=${asString(
          input.status.serving_passport_id,
        )} passport=${passportId}`,
      )
    }

    const decision = asString(passport.decision)
    if (decision !== 'allow') {
      const reasons = asArray(passport.reason_codes)
        .map((entry) => asString(entry))
        .filter((entry): entry is string => Boolean(entry))
      throw new Error(
        `Admission passport ${passportId} for ${consumer} is not allow: decision=${decision ?? 'missing'} reasons=${
          reasons.join(',') || 'none'
        }`,
      )
    }

    const runtimeKitSetDigest = asString(passport.runtime_kit_set_digest)
    if (!runtimeKitSetDigest) {
      throw new Error(`Admission passport ${passportId} for ${consumer} does not include runtime_kit_set_digest`)
    }
    if (parseFreshUntilMs(passport.fresh_until, `Admission passport ${passportId}`) <= nowMs) {
      throw new Error(`Admission passport ${passportId} for ${consumer} is stale`)
    }

    const passportRuntimeKitIds = asArray(passport.required_runtime_kits)
      .map((entry) => asString(entry))
      .filter((entry): entry is string => Boolean(entry))
    if (passportRuntimeKitIds.length === 0) {
      throw new Error(`Admission passport ${passportId} for ${consumer} does not cite required_runtime_kits`)
    }

    passportIds.push(passportId)
    runtimeKitSetDigests.push(runtimeKitSetDigest)
    requiredRuntimeKitIds.push(...passportRuntimeKitIds)
  }

  const runtimeImageRefs: string[] = []
  for (const runtimeKitId of uniqueStrings(requiredRuntimeKitIds)) {
    const runtimeKit = runtimeKitById.get(runtimeKitId)
    if (!runtimeKit) {
      throw new Error(`Admission passport cites missing runtime kit ${runtimeKitId}`)
    }

    const decision = asString(runtimeKit.decision)
    if (decision !== 'healthy') {
      throw new Error(`Runtime kit ${runtimeKitId} is not healthy: decision=${decision ?? 'missing'}`)
    }
    if (parseFreshUntilMs(runtimeKit.fresh_until, `Runtime kit ${runtimeKitId}`) <= nowMs) {
      throw new Error(`Runtime kit ${runtimeKitId} is stale`)
    }

    const imageRef = asString(runtimeKit.image_ref)
    if (!imageRef) {
      throw new Error(`Runtime kit ${runtimeKitId} does not include image_ref`)
    }
    if (!imageRefMatchesExpectedDigest(imageRef, input.expectedDigest)) {
      throw new Error(
        `Runtime kit ${runtimeKitId} image_ref ${imageRef} does not match expected rollout digest ${
          input.expectedDigest
        }`,
      )
    }
    runtimeImageRefs.push(imageRef)
  }

  return {
    consumers: input.consumers,
    passportIds,
    runtimeKitSetDigests: uniqueStrings(runtimeKitSetDigests),
    runtimeKitIds: uniqueStrings(requiredRuntimeKitIds),
    runtimeImageRefs: uniqueStrings(runtimeImageRefs),
  }
}

const verifyRuntimeProofSurfaceParity = (input: {
  status: ControlPlaneStatusPayload
  expectedDigest: string
  consumers: AdmissionPassportConsumer[]
  now?: Date
}): RuntimeProofSurfaceParityEvidence => {
  const nowMs = (input.now ?? new Date()).getTime()
  const admissionPassports = asArray(input.status.admission_passports)
    .map((entry) => asRecord(entry) as AdmissionPassportStatus | null)
    .filter((entry): entry is AdmissionPassportStatus => Boolean(entry))
  const recoveryWarrants = asArray(input.status.recovery_warrants)
    .map((entry) => asRecord(entry) as RecoveryWarrantStatus | null)
    .filter((entry): entry is RecoveryWarrantStatus => Boolean(entry))
  const runtimeProofCells = asArray(input.status.runtime_proof_cells)
    .map((entry) => asRecord(entry) as RuntimeProofCellStatus | null)
    .filter((entry): entry is RuntimeProofCellStatus => Boolean(entry))
  const projectionWatermarks = asArray(input.status.projection_watermarks)
    .map((entry) => asRecord(entry) as ProjectionWatermarkStatus | null)
    .filter((entry): entry is ProjectionWatermarkStatus => Boolean(entry))

  if (admissionPassports.length === 0) {
    throw new Error('Control-plane status did not include admission_passports')
  }
  if (recoveryWarrants.length === 0) {
    throw new Error('Control-plane status did not include recovery_warrants')
  }
  if (runtimeProofCells.length === 0) {
    throw new Error('Control-plane status did not include runtime_proof_cells')
  }
  if (projectionWatermarks.length === 0) {
    throw new Error('Control-plane status did not include projection_watermarks')
  }

  const passportByConsumer = new Map<AdmissionPassportConsumer, AdmissionPassportStatus>()
  for (const passport of admissionPassports) {
    const consumer = admissionPassportConsumer(passport)
    if (consumer && supportedAdmissionPassportConsumers.includes(consumer)) {
      passportByConsumer.set(consumer, passport)
    }
  }

  const proofCellById = new Map<string, RuntimeProofCellStatus>()
  for (const proofCell of runtimeProofCells) {
    const id = asString(proofCell.runtime_proof_cell_id)
    if (id) proofCellById.set(id, proofCell)
  }

  for (const warrant of recoveryWarrants) {
    if (asString(warrant.status) !== 'superseded') {
      continue
    }

    const warrantId = asString(warrant.recovery_warrant_id) ?? 'unknown'
    const activeBacklogSeatCount = asNumber(warrant.active_backlog_seat_count)
    if (activeBacklogSeatCount === null) {
      throw new Error(`superseded recovery warrant ${warrantId} is missing active_backlog_seat_count`)
    }
    if (activeBacklogSeatCount > 0) {
      throw new Error(
        `superseded recovery warrant ${warrantId} still has ${activeBacklogSeatCount} active backlog seats`,
      )
    }
  }

  const warrantIds: string[] = []
  const proofCellIds: string[] = []
  const projectionWatermarkIds: string[] = []

  for (const consumer of input.consumers) {
    const passport = passportByConsumer.get(consumer)
    if (!passport) {
      throw new Error(`Missing admission passport for consumer ${consumer}`)
    }

    const passportId = asString(passport.admission_passport_id)
    if (!passportId) {
      throw new Error(`Admission passport for consumer ${consumer} does not include admission_passport_id`)
    }

    const runtimeKitSetDigest = asString(passport.runtime_kit_set_digest)
    if (!runtimeKitSetDigest) {
      throw new Error(`Admission passport ${passportId} for ${consumer} does not include runtime_kit_set_digest`)
    }

    const executionClass = deploymentWarrantExecutionClassByConsumer[consumer]
    const matchingWarrants = recoveryWarrants.filter(
      (warrant) =>
        asString(warrant.execution_class) === executionClass &&
        asString(warrant.admission_passport_id) === passportId &&
        asString(warrant.status) !== 'superseded',
    )

    if (matchingWarrants.length === 0) {
      throw new Error(`Missing ${executionClass} recovery warrant for admission passport ${passportId}`)
    }
    if (matchingWarrants.length > 1) {
      throw new Error(`Multiple ${executionClass} recovery warrants found for admission passport ${passportId}`)
    }

    const warrant = matchingWarrants[0]
    const warrantId = asString(warrant.recovery_warrant_id)
    if (!warrantId) {
      throw new Error(`${executionClass} recovery warrant for admission passport ${passportId} is missing id`)
    }

    const warrantStatus = asString(warrant.status)
    if (warrantStatus !== 'sealed') {
      throw new Error(
        `Recovery warrant ${warrantId} for ${consumer} is not sealed: status=${
          warrantStatus ?? 'missing'
        } reasons=${reasonList(warrant.reason_codes)}`,
      )
    }

    const warrantRuntimeKitDigest = asString(warrant.runtime_kit_digest)
    if (warrantRuntimeKitDigest !== runtimeKitSetDigest) {
      throw new Error(
        `Recovery warrant ${warrantId} runtime_kit_digest=${warrantRuntimeKitDigest ?? 'missing'} does not match ` +
          `passport ${passportId} runtime_kit_set_digest=${runtimeKitSetDigest}`,
      )
    }

    const admittedImageDigest = asString(warrant.admitted_image_digest)
    if (!admittedImageDigest || !imageRefMatchesExpectedDigest(admittedImageDigest, input.expectedDigest)) {
      throw new Error(
        `Recovery warrant ${warrantId} admitted_image_digest=${admittedImageDigest ?? 'missing'} does not match ` +
          `expected rollout digest ${input.expectedDigest}`,
      )
    }

    const requiredProofCellIds = stringList(warrant.required_proof_cell_ids)
    if (requiredProofCellIds.length === 0) {
      throw new Error(`Recovery warrant ${warrantId} does not cite required_proof_cell_ids`)
    }

    for (const proofCellId of requiredProofCellIds) {
      const proofCell = proofCellById.get(proofCellId)
      if (!proofCell) {
        throw new Error(`Recovery warrant ${warrantId} cites missing runtime proof cell ${proofCellId}`)
      }
      if (asString(proofCell.recovery_warrant_id) !== warrantId) {
        throw new Error(`Runtime proof cell ${proofCellId} does not belong to recovery warrant ${warrantId}`)
      }
      if (asBoolean(proofCell.required) !== true) {
        throw new Error(`Runtime proof cell ${proofCellId} is not marked required`)
      }

      const proofCellStatus = asString(proofCell.status)
      if (proofCellStatus !== 'healthy') {
        throw new Error(
          `Runtime proof cell ${proofCellId} for warrant ${warrantId} is not healthy: status=${
            proofCellStatus ?? 'missing'
          } reasons=${reasonList(proofCell.reason_codes)}`,
        )
      }
      if (parseFreshUntilMs(proofCell.expires_at, `Runtime proof cell ${proofCellId}`) <= nowMs) {
        throw new Error(`Runtime proof cell ${proofCellId} for warrant ${warrantId} is stale`)
      }

      proofCellIds.push(proofCellId)
    }

    const warrantWatermarkIds = stringList(warrant.projection_watermark_ids)
    const deployWatermark = projectionWatermarks.find(
      (watermark) =>
        asString(watermark.consumer_key) === 'deploy_verification' &&
        asString(watermark.recovery_warrant_id) === warrantId,
    )
    if (!deployWatermark) {
      throw new Error(`Missing deploy verification projection watermark for recovery warrant ${warrantId}`)
    }

    const deployWatermarkId = asString(deployWatermark.projection_watermark_id)
    if (!deployWatermarkId) {
      throw new Error(`Deploy verification projection watermark for recovery warrant ${warrantId} is missing id`)
    }
    if (!warrantWatermarkIds.includes(deployWatermarkId)) {
      throw new Error(
        `Recovery warrant ${warrantId} does not cite deploy verification projection watermark ${deployWatermarkId}`,
      )
    }
    if (asString(deployWatermark.source_ref) !== `admission-passport:${passportId}`) {
      throw new Error(
        `Deploy verification projection watermark ${deployWatermarkId} source_ref=${
          asString(deployWatermark.source_ref) ?? 'missing'
        } does not cite admission passport ${passportId}`,
      )
    }
    if (!asString(deployWatermark.projection_digest)) {
      throw new Error(
        `Deploy verification projection watermark ${deployWatermarkId} does not include projection_digest`,
      )
    }

    const deployWatermarkStatus = asString(deployWatermark.status)
    if (deployWatermarkStatus !== 'fresh') {
      throw new Error(
        `Deploy verification projection watermark ${deployWatermarkId} for warrant ${warrantId} is not fresh: ` +
          `status=${deployWatermarkStatus ?? 'missing'} reasons=${reasonList(deployWatermark.reason_codes)}`,
      )
    }
    if (
      parseFreshUntilMs(deployWatermark.expires_at, `Deploy verification projection watermark ${deployWatermarkId}`) <=
      nowMs
    ) {
      throw new Error(`Deploy verification projection watermark ${deployWatermarkId} for warrant ${warrantId} is stale`)
    }

    warrantIds.push(warrantId)
    projectionWatermarkIds.push(deployWatermarkId)
  }

  return {
    consumers: input.consumers,
    warrantIds,
    proofCellIds: uniqueStrings(proofCellIds),
    projectionWatermarkIds,
  }
}

const authorityDecisionFor = (
  settlement: AuthorityProvenanceSettlementStatus,
  actionClass: string,
): AuthorityProvenanceActionDecision | null =>
  asArray(settlement.action_class_decisions)
    .map((entry) => asRecord(entry) as AuthorityProvenanceActionDecision | null)
    .filter((entry): entry is AuthorityProvenanceActionDecision => Boolean(entry))
    .find((entry) => asString(entry.action_class) === actionClass) ?? null

const validateAuthorityDecision = (decision: AuthorityProvenanceActionDecision | null, actionClass: string) => {
  if (!decision) {
    throw new Error(`Authority provenance settlement does not include ${actionClass} decision`)
  }
  const value = asString(decision.decision)
  if (
    !value ||
    !supportedAuthorityProvenanceActionDecisions.includes(
      value as (typeof supportedAuthorityProvenanceActionDecisions)[number],
    )
  ) {
    throw new Error(`Authority provenance ${actionClass} decision is invalid: ${value ?? 'missing'}`)
  }
  return value
}

const verifyAuthorityProvenanceSettlement = (input: {
  status: ControlPlaneStatusPayload
  enforceDecisions: boolean
  now?: Date
}): AuthorityProvenanceEvidence => {
  const settlement = asRecord(
    input.status.authority_provenance_settlement,
  ) as AuthorityProvenanceSettlementStatus | null
  if (!settlement) {
    throw new Error('Control-plane status did not include authority_provenance_settlement')
  }
  if (asString(settlement.schema_version) !== 'jangar.authority-provenance-settlement.v1') {
    throw new Error('authority_provenance_settlement has an unsupported schema_version')
  }

  const settlementId = asString(settlement.settlement_id)
  if (!settlementId) {
    throw new Error('authority_provenance_settlement does not include settlement_id')
  }
  const evidenceMode = asString(settlement.evidence_mode)
  if (
    !evidenceMode ||
    !supportedAuthorityProvenanceEvidenceModes.includes(
      evidenceMode as (typeof supportedAuthorityProvenanceEvidenceModes)[number],
    )
  ) {
    throw new Error(
      `Authority provenance settlement ${settlementId} has invalid evidence_mode ${evidenceMode ?? 'missing'}`,
    )
  }
  const settlementState = asString(settlement.settlement_state)
  if (
    !settlementState ||
    !supportedAuthorityProvenanceSettlementStates.includes(
      settlementState as (typeof supportedAuthorityProvenanceSettlementStates)[number],
    )
  ) {
    throw new Error(`Authority provenance settlement ${settlementId} has invalid state ${settlementState ?? 'missing'}`)
  }
  const winningAuthority = asString(settlement.winning_authority)
  if (!winningAuthority) {
    throw new Error(`Authority provenance settlement ${settlementId} does not include winning_authority`)
  }
  if (!asString(settlement.rollback_target)) {
    throw new Error(`Authority provenance settlement ${settlementId} does not include rollback_target`)
  }
  if (!asString(settlement.handoff_summary)) {
    throw new Error(`Authority provenance settlement ${settlementId} does not include handoff_summary`)
  }
  if (
    parseFreshUntilMs(settlement.fresh_until, `Authority provenance settlement ${settlementId}`) <=
    (input.now ?? new Date()).getTime()
  ) {
    throw new Error(`Authority provenance settlement ${settlementId} is stale`)
  }

  const deployWidenDecision = validateAuthorityDecision(
    authorityDecisionFor(settlement, 'deploy_widen'),
    'deploy_widen',
  )
  const mergeReadyDecision = validateAuthorityDecision(authorityDecisionFor(settlement, 'merge_ready'), 'merge_ready')
  const reentryWindowCount = asArray(settlement.reentry_windows).length
  const enforceDecisions = input.enforceDecisions || evidenceMode === 'enforce'

  if (enforceDecisions && deployWidenDecision !== 'allow') {
    const decision = authorityDecisionFor(settlement, 'deploy_widen')
    throw new Error(
      `Authority provenance deploy_widen is not allow: decision=${deployWidenDecision} reasons=${reasonList(
        decision?.reason_codes,
      )}`,
    )
  }
  if (enforceDecisions && mergeReadyDecision !== 'allow') {
    const decision = authorityDecisionFor(settlement, 'merge_ready')
    throw new Error(
      `Authority provenance merge_ready is not allow: decision=${mergeReadyDecision} reasons=${reasonList(
        decision?.reason_codes,
      )}`,
    )
  }

  return {
    settlementId,
    evidenceMode,
    settlementState,
    winningAuthority,
    deployWidenDecision,
    mergeReadyDecision,
    reentryWindowCount,
  }
}

export const main = async (cliOptions?: CliOptions) => {
  ensureCli('kubectl')

  const parsed = cliOptions ?? parseArgs(process.argv.slice(2))
  const expectedRevision = parsed.expectedRevision?.trim() || undefined
  const expectedRevisionMode = validateExpectedRevisionMode(parsed.expectedRevisionMode)
  const namespace = parsed.namespace ?? defaultNamespace
  const verifyAdmissionPassports = parseBoolean(process.env.JANGAR_VERIFY_ADMISSION_PASSPORTS, true)
  const verifyRuntimeProofSurface = parseBoolean(process.env.JANGAR_VERIFY_RUNTIME_PROOF_SURFACE, true)
  const verifyAuthorityProvenance = parseBoolean(process.env.JANGAR_VERIFY_AUTHORITY_PROVENANCE_SETTLEMENT, true)
  const enforceAuthorityProvenanceDecisions = parseBoolean(
    process.env.JANGAR_VERIFY_AUTHORITY_PROVENANCE_ENFORCED,
    false,
  )
  const skipAdmissionPassportVerification = parsed.skipAdmissionPassportVerification ?? !verifyAdmissionPassports
  const resolvedOptions: ResolvedOptions = {
    namespace,
    deployments: parsed.deployments?.length ? parsed.deployments : [...defaultDeployments],
    kustomizationPath: parsed.kustomizationPath ?? defaultKustomizationPath,
    imageName: parsed.imageName ?? defaultImageName,
    argoNamespace: parsed.argoNamespace ?? defaultArgoNamespace,
    argoApplication: parsed.argoApplication ?? defaultArgoApplication,
    statusServiceNamespace:
      parsed.statusServiceNamespace ?? process.env.JANGAR_VERIFY_STATUS_SERVICE_NAMESPACE ?? namespace,
    statusServiceName:
      parsed.statusServiceName ?? process.env.JANGAR_VERIFY_STATUS_SERVICE_NAME ?? defaultStatusServiceName,
    statusServicePort:
      parsed.statusServicePort ?? process.env.JANGAR_VERIFY_STATUS_SERVICE_PORT ?? defaultStatusServicePort,
    controlPlaneStatusNamespace:
      parsed.controlPlaneStatusNamespace ??
      process.env.JANGAR_VERIFY_CONTROL_PLANE_STATUS_NAMESPACE ??
      defaultControlPlaneStatusNamespace,
    admissionPassportConsumers: parsed.admissionPassportConsumers ??
      parseAdmissionPassportConsumers(process.env.JANGAR_VERIFY_ADMISSION_PASSPORT_CONSUMERS) ?? [
        ...defaultAdmissionPassportConsumers,
      ],
    rolloutTimeout: parsed.rolloutTimeout ?? defaultRolloutTimeout,
    healthAttempts: parsed.healthAttempts ?? defaultHealthAttempts,
    healthIntervalSeconds: parsed.healthIntervalSeconds ?? defaultHealthIntervalSeconds,
    expectedRevision,
    expectedRevisionMode,
    digestAttempts: parsed.digestAttempts ?? defaultDigestAttempts,
    digestIntervalSeconds: parsed.digestIntervalSeconds ?? defaultDigestIntervalSeconds,
    requireSynced: parsed.requireSynced ?? false,
    skipAdmissionPassportVerification,
    skipRuntimeProofVerification:
      parsed.skipRuntimeProofVerification ?? (skipAdmissionPassportVerification || !verifyRuntimeProofSurface),
    skipAuthorityProvenanceVerification: parsed.skipAuthorityProvenanceVerification ?? !verifyAuthorityProvenance,
    enforceAuthorityProvenanceDecisions,
  }

  if (!Number.isInteger(resolvedOptions.healthAttempts) || resolvedOptions.healthAttempts <= 0) {
    throw new Error(`healthAttempts must be a positive integer, received ${resolvedOptions.healthAttempts}`)
  }
  if (!Number.isInteger(resolvedOptions.healthIntervalSeconds) || resolvedOptions.healthIntervalSeconds <= 0) {
    throw new Error(
      `healthIntervalSeconds must be a positive integer, received ${resolvedOptions.healthIntervalSeconds}`,
    )
  }
  if (!Number.isInteger(resolvedOptions.digestAttempts) || resolvedOptions.digestAttempts <= 0) {
    throw new Error(`digestAttempts must be a positive integer, received ${resolvedOptions.digestAttempts}`)
  }
  if (!Number.isInteger(resolvedOptions.digestIntervalSeconds) || resolvedOptions.digestIntervalSeconds <= 0) {
    throw new Error(
      `digestIntervalSeconds must be a positive integer, received ${resolvedOptions.digestIntervalSeconds}`,
    )
  }
  if (resolvedOptions.expectedRevision && !shaPattern.test(resolvedOptions.expectedRevision)) {
    throw new Error(
      `expectedRevision must be a full 40-character commit SHA, received ${resolvedOptions.expectedRevision}`,
    )
  }
  if (!resolvedOptions.statusServicePort.trim()) {
    throw new Error('statusServicePort must be non-empty')
  }
  if (!resolvedOptions.skipAdmissionPassportVerification && resolvedOptions.admissionPassportConsumers.length === 0) {
    throw new Error('admissionPassportConsumers must include at least one consumer')
  }

  const kustomizationPath = resolvePath(resolvedOptions.kustomizationPath)
  const kustomizationSource = readFileSync(kustomizationPath, 'utf8')
  const expectedDigest = extractExpectedDigest(kustomizationSource, resolvedOptions.imageName)

  console.log(`Expected digest: ${expectedDigest}`)
  if (resolvedOptions.expectedRevision) {
    console.log(`Expected revision: ${resolvedOptions.expectedRevision}`)
  }
  await waitForArgoState(resolvedOptions)
  await verifyRollouts(resolvedOptions.namespace, resolvedOptions.deployments, resolvedOptions.rolloutTimeout)
  await verifyDeploymentDigests(
    resolvedOptions.namespace,
    resolvedOptions.deployments,
    expectedDigest,
    resolvedOptions.digestAttempts,
    resolvedOptions.digestIntervalSeconds,
  )

  const shouldReadControlPlaneStatus =
    !resolvedOptions.skipAdmissionPassportVerification ||
    !resolvedOptions.skipRuntimeProofVerification ||
    !resolvedOptions.skipAuthorityProvenanceVerification
  const controlPlaneStatus = shouldReadControlPlaneStatus ? await readControlPlaneStatus(resolvedOptions) : undefined
  const requireControlPlaneStatus = () => {
    if (!controlPlaneStatus) {
      throw new Error('Control-plane status is required for runtime admission verification')
    }
    return controlPlaneStatus
  }

  if (resolvedOptions.skipAdmissionPassportVerification) {
    console.log('Admission passport verification skipped by operator flag.')
  } else {
    const passportEvidence = verifyAdmissionPassportParity({
      status: requireControlPlaneStatus(),
      expectedDigest,
      consumers: resolvedOptions.admissionPassportConsumers,
    })
    console.log(`Admission passports verified: ${passportEvidence.passportIds.join(', ')}`)
    console.log(`Runtime kit set digests: ${passportEvidence.runtimeKitSetDigests.join(', ')}`)
    console.log(`Runtime kit image refs: ${passportEvidence.runtimeImageRefs.join(', ')}`)
  }

  if (resolvedOptions.skipAuthorityProvenanceVerification) {
    console.log('Authority provenance settlement verification skipped by operator flag.')
  } else {
    const authorityEvidence = verifyAuthorityProvenanceSettlement({
      status: requireControlPlaneStatus(),
      enforceDecisions: resolvedOptions.enforceAuthorityProvenanceDecisions,
    })
    console.log(
      `Authority provenance verified: ${authorityEvidence.settlementId} state=${
        authorityEvidence.settlementState
      } winner=${authorityEvidence.winningAuthority}`,
    )
    console.log(
      `Authority deploy decisions: deploy_widen=${authorityEvidence.deployWidenDecision} merge_ready=${
        authorityEvidence.mergeReadyDecision
      } reentry_windows=${authorityEvidence.reentryWindowCount}`,
    )
  }

  if (resolvedOptions.skipRuntimeProofVerification) {
    console.log('Runtime proof surface verification skipped by operator flag.')
    return
  }

  const runtimeProofEvidence = verifyRuntimeProofSurfaceParity({
    status: requireControlPlaneStatus(),
    expectedDigest,
    consumers: resolvedOptions.admissionPassportConsumers,
  })
  console.log(`Recovery warrants verified: ${runtimeProofEvidence.warrantIds.join(', ')}`)
  console.log(`Runtime proof cells verified: ${runtimeProofEvidence.proofCellIds.join(', ')}`)
  console.log(`Deploy verification watermarks verified: ${runtimeProofEvidence.projectionWatermarkIds.join(', ')}`)
}

if (import.meta.main) {
  main().catch((error) => fatal('Failed to verify jangar deployment rollout', error))
}

export const __private = {
  ensureRevisionAvailable,
  extractExpectedDigest,
  buildControlPlaneStatusProxyPath,
  getArgoWaitReason,
  imageRefMatchesExpectedDigest,
  isExpectedRevisionSatisfied,
  parseArgs,
  parseAdmissionPassportConsumers,
  defaultAdmissionPassportConsumers,
  verifyAuthorityProvenanceSettlement,
  verifyAdmissionPassportParity,
  verifyRuntimeProofSurfaceParity,
}
