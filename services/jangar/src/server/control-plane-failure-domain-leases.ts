import { createHash } from 'node:crypto'

import type {
  FailureDomainActionClass,
  FailureDomainHoldbackDecision,
  FailureDomainLease,
  FailureDomainLeaseDomain,
  FailureDomainLeaseSet,
  FailureDomainLeaseStatus,
  RuntimeKitStatus,
  WorkflowsReliabilityStatus,
} from '~/data/agents-control-plane'
import type {
  ControlPlaneRolloutHealth,
  DatabaseStatus,
  DeploymentRolloutStatus,
} from '~/server/control-plane-status-types'
import type { KubeGateway, KubeGatewayEvent, KubeGatewayPod } from '~/server/kube-gateway'

export const FAILURE_DOMAIN_LEASES_DESIGN_ARTIFACT =
  'docs/agents/designs/75-jangar-failure-domain-leases-and-database-routability-holdbacks-2026-05-05.md'

const VALID_LEASE_TTL_MS = 60_000
const NON_VALID_LEASE_TTL_MS = 0
const ROUTE_PROBE_TIMEOUT_MS = 2_000
const DEFAULT_APP_NAMESPACE = 'jangar'
const IMAGE_PULL_REASONS = new Set(['ErrImagePull', 'ImagePullBackOff', 'InvalidImageName'])

export type FailureDomainRouteProbe = {
  status: 'healthy' | 'degraded' | 'unknown'
  reachable: boolean
  url: string | null
  status_code: number | null
  latency_ms: number
  message: string
  observed_at: string
}

export type FailureDomainKubernetesEvidence = {
  pods: KubeGatewayPod[]
  events: KubeGatewayEvent[]
  collection_errors: string[]
}

export type FailureDomainLeaseSetInput = {
  now: Date
  namespace: string
  service: string
  database: DatabaseStatus
  routeProbe: FailureDomainRouteProbe
  rolloutHealth: ControlPlaneRolloutHealth
  workflows: WorkflowsReliabilityStatus
  runtimeKits: RuntimeKitStatus[]
  kubernetesEvidence: FailureDomainKubernetesEvidence
}

export type FailureDomainRouteProbeInput = {
  now: Date
  namespace: string
  service: string
  env?: Record<string, string | undefined>
}

export type FailureDomainKubernetesEvidenceInput = {
  namespace: string
  service: string
  kube: KubeGateway
  env?: Record<string, string | undefined>
}

export const emptyFailureDomainKubernetesEvidence = (): FailureDomainKubernetesEvidence => ({
  pods: [],
  events: [],
  collection_errors: [],
})

const normalizeNonEmpty = (value: string | undefined | null) => {
  const normalized = value?.trim()
  return normalized && normalized.length > 0 ? normalized : null
}

const parseBoolean = (value: string | undefined, fallback: boolean) => {
  const normalized = normalizeNonEmpty(value)?.toLowerCase()
  if (!normalized) return fallback
  if (['1', 'true', 'yes', 'y', 'on', 'enabled'].includes(normalized)) return true
  if (['0', 'false', 'no', 'n', 'off', 'disabled'].includes(normalized)) return false
  return fallback
}

const parsePositiveInt = (value: string | undefined, fallback: number) => {
  const normalized = normalizeNonEmpty(value)
  if (!normalized) return fallback
  const parsed = Number.parseInt(normalized, 10)
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : fallback
}

const uniqueStrings = (values: string[]) => [...new Set(values.filter((value) => value.length > 0))]

const normalizeErrorMessage = (value: unknown) => (value instanceof Error ? value.message : String(value))

const hashJson = (value: unknown, length = 16) =>
  createHash('sha256').update(JSON.stringify(value)).digest('hex').slice(0, length)

const normalizeText = (value: string | null | undefined) => (value ?? '').trim().toLowerCase()

const leaseExpiry = (now: Date, status: FailureDomainLeaseStatus) =>
  new Date(
    now.getTime() + (status === 'valid' || status === 'override' ? VALID_LEASE_TTL_MS : NON_VALID_LEASE_TTL_MS),
  ).toISOString()

const buildLease = ({
  domain,
  scope,
  status,
  actionClasses,
  now,
  reasonCodes,
  evidenceRefs,
  rollbackTarget = null,
}: {
  domain: FailureDomainLeaseDomain
  scope: string
  status: FailureDomainLeaseStatus
  actionClasses: FailureDomainActionClass[]
  now: Date
  reasonCodes: string[]
  evidenceRefs: string[]
  rollbackTarget?: string | null
}): FailureDomainLease => {
  const observedAt = now.toISOString()
  const uniqueReasonCodes = uniqueStrings(reasonCodes)
  const uniqueEvidenceRefs = uniqueStrings(evidenceRefs)
  const stableInput = {
    domain,
    scope,
    status,
    actionClasses,
    reasonCodes: uniqueReasonCodes,
    evidenceRefs: uniqueEvidenceRefs,
    observedAt,
  }

  return {
    lease_id: `fdl:${domain}:${hashJson(stableInput)}`,
    domain,
    scope,
    status,
    action_classes: uniqueStrings(actionClasses) as FailureDomainActionClass[],
    observed_at: observedAt,
    expires_at: leaseExpiry(now, status),
    evidence_refs: uniqueEvidenceRefs,
    reason_codes: uniqueReasonCodes,
    rollback_target: rollbackTarget,
    issuer: 'status_projector',
  }
}

const conditionIsTrue = (condition: { status: string | null }) => normalizeText(condition.status) === 'true'

const hasDatabaseNameToken = (name: string) => /(^|[-_.])(db|database|postgres|postgresql)($|[-_.0-9])/.test(name)

const isDatabasePod = (pod: KubeGatewayPod) => {
  const name = normalizeText(pod.metadata.name)
  const labels = pod.metadata.labels
  return (
    hasDatabaseNameToken(name) ||
    Boolean(labels['cnpg.io/cluster']) ||
    normalizeText(labels['app.kubernetes.io/name']).includes('postgres') ||
    normalizeText(labels['app.kubernetes.io/name']).includes('database') ||
    normalizeText(labels['app.kubernetes.io/component']).includes('database') ||
    normalizeText(labels.app).includes('postgres') ||
    normalizeText(labels.app).includes('database')
  )
}

const podHasDisruptionTarget = (pod: KubeGatewayPod) =>
  pod.status.conditions.some((condition) => condition.type === 'DisruptionTarget' && conditionIsTrue(condition))

const podReadyCondition = (pod: KubeGatewayPod) =>
  pod.status.conditions.find((condition) => condition.type === 'Ready') ?? null

const podHasReadyContainer = (pod: KubeGatewayPod) => pod.status.containerStatuses.some((container) => container.ready)

const podEvidenceRef = (pod: KubeGatewayPod) => `pod:${pod.metadata.namespace ?? 'unknown'}:${pod.metadata.name}`

const eventEvidenceRef = (event: KubeGatewayEvent) =>
  `event:${event.metadata.namespace ?? 'unknown'}:${event.metadata.name}`

const hasDatabasePodSplitReadiness = (pod: KubeGatewayPod) => {
  const readyCondition = podReadyCondition(pod)
  return Boolean(pod.metadata.deletionTimestamp) || podHasDisruptionTarget(pod) || readyCondition?.status === 'False'
}

const classifyDatabaseMessage = (message: string) => {
  const normalized = normalizeText(message)
  if (normalized.includes('econnrefused') || normalized.includes('connection refused')) {
    return 'database.service_refused'
  }
  if (normalized.includes('timeout') || normalized.includes('timed out')) {
    return 'database.query_timeout'
  }
  if (normalized.includes('database_url not set')) {
    return 'database.unconfigured'
  }
  return 'database.unreachable'
}

const buildDatabaseLease = (input: FailureDomainLeaseSetInput): FailureDomainLease => {
  const databasePods = input.kubernetesEvidence.pods.filter(isDatabasePod)
  const splitReadinessPods = databasePods.filter(hasDatabasePodSplitReadiness)
  const actionClasses: FailureDomainActionClass[] = [
    'dispatch_normal',
    'deploy_widen',
    'merge_ready',
    'torghut_capital',
  ]

  if (splitReadinessPods.length > 0) {
    const reasonCodes = uniqueStrings(
      splitReadinessPods.flatMap((pod) => [
        podHasDisruptionTarget(pod) ? 'database.pod_disruption_target' : '',
        pod.metadata.deletionTimestamp ? 'database.pod_terminating' : '',
        podHasReadyContainer(pod) ? 'database.container_ready_pod_not_ready' : '',
      ]),
    )
    return buildLease({
      domain: 'database',
      scope: input.service,
      status: 'expired',
      actionClasses,
      now: input.now,
      reasonCodes,
      evidenceRefs: splitReadinessPods.map(podEvidenceRef),
      rollbackTarget: 'restore last database pod with Pod Ready=True and routable service endpoint',
    })
  }

  if (!input.database.configured) {
    return buildLease({
      domain: 'database',
      scope: input.service,
      status: 'unknown',
      actionClasses,
      now: input.now,
      reasonCodes: ['database.unconfigured'],
      evidenceRefs: ['database:config:DATABASE_URL'],
      rollbackTarget: 'restore DATABASE_URL or keep dispatch enforcement disabled',
    })
  }

  if (!input.database.connected || input.database.status !== 'healthy') {
    return buildLease({
      domain: 'database',
      scope: input.service,
      status: input.database.connected ? 'degraded' : 'expired',
      actionClasses,
      now: input.now,
      reasonCodes: [classifyDatabaseMessage(input.database.message)],
      evidenceRefs: ['database:probe:select_1'],
      rollbackTarget: 'repair database service routability before widening or normal dispatch',
    })
  }

  return buildLease({
    domain: 'database',
    scope: input.service,
    status: 'valid',
    actionClasses,
    now: input.now,
    reasonCodes: [],
    evidenceRefs: ['database:probe:select_1'],
  })
}

const buildRouteLease = (input: FailureDomainLeaseSetInput): FailureDomainLease => {
  const actionClasses: FailureDomainActionClass[] = ['serve_readonly', 'dispatch_normal', 'torghut_capital']

  if (input.routeProbe.status === 'healthy' && input.routeProbe.reachable) {
    return buildLease({
      domain: 'route',
      scope: input.routeProbe.url ?? input.service,
      status: 'valid',
      actionClasses,
      now: input.now,
      reasonCodes: [],
      evidenceRefs: [input.routeProbe.url ? `route:${input.routeProbe.url}` : 'route:status_handler_reached'],
    })
  }

  const reasonCode =
    input.routeProbe.status_code == null
      ? 'route.unreachable'
      : input.routeProbe.status_code >= 500
        ? `route.http_${input.routeProbe.status_code}`
        : 'route.unexpected_status'

  return buildLease({
    domain: 'route',
    scope: input.routeProbe.url ?? input.service,
    status: input.routeProbe.status === 'unknown' ? 'unknown' : 'expired',
    actionClasses,
    now: input.now,
    reasonCodes: [reasonCode],
    evidenceRefs: [input.routeProbe.url ? `route:${input.routeProbe.url}` : 'route:probe_unavailable'],
    rollbackTarget: 'restore Jangar route health or keep normal dispatch and capital held',
  })
}

const isImagePullContainer = (pod: KubeGatewayPod) =>
  pod.status.containerStatuses.some((container) => {
    const reason = container.state.waiting?.reason
    const message = normalizeText(container.state.waiting?.message)
    return Boolean(
      (reason && IMAGE_PULL_REASONS.has(reason)) ||
      message.includes('imagepull') ||
      message.includes('image pull') ||
      message.includes('pull image'),
    )
  })

const isImagePullEvent = (event: KubeGatewayEvent) => {
  const reason = event.reason ?? ''
  const message = normalizeText(event.message)
  return (
    IMAGE_PULL_REASONS.has(reason) ||
    message.includes('imagepull') ||
    message.includes('image pull') ||
    message.includes('pull image') ||
    message.includes('failed to pull')
  )
}

const deploymentHasImagePullMessage = (deployment: DeploymentRolloutStatus) => {
  const message = normalizeText(deployment.message)
  return message.includes('imagepull') || message.includes('image pull') || message.includes('pull image')
}

const buildRegistryLease = (input: FailureDomainLeaseSetInput): FailureDomainLease => {
  const imagePullPods = input.kubernetesEvidence.pods.filter(isImagePullContainer)
  const imagePullEvents = input.kubernetesEvidence.events.filter(isImagePullEvent)
  const imagePullDeployments = input.rolloutHealth.deployments.filter(deploymentHasImagePullMessage)

  if (imagePullPods.length > 0 || imagePullEvents.length > 0 || imagePullDeployments.length > 0) {
    return buildLease({
      domain: 'registry',
      scope: input.service,
      status: 'expired',
      actionClasses: ['deploy_widen'],
      now: input.now,
      reasonCodes: ['registry.image_pull_timeout'],
      evidenceRefs: [
        ...imagePullPods.map(podEvidenceRef),
        ...imagePullEvents.map(eventEvidenceRef),
        ...imagePullDeployments.map((deployment) => `deployment:${deployment.namespace}:${deployment.name}`),
      ],
      rollbackTarget: 'roll back to last digest with successful image pull evidence',
    })
  }

  return buildLease({
    domain: 'registry',
    scope: input.service,
    status: 'valid',
    actionClasses: ['deploy_widen'],
    now: input.now,
    reasonCodes: [],
    evidenceRefs: ['registry:no_recent_image_pull_failures'],
  })
}

const buildRolloutLease = (input: FailureDomainLeaseSetInput): FailureDomainLease => {
  if (input.rolloutHealth.status === 'unknown') {
    return buildLease({
      domain: 'rollout',
      scope: input.namespace,
      status: 'unknown',
      actionClasses: ['dispatch_normal', 'deploy_widen', 'torghut_capital'],
      now: input.now,
      reasonCodes: ['rollout.health_unknown'],
      evidenceRefs: ['rollout:query_failed'],
      rollbackTarget: 'restore deployment read access or keep widening blocked',
    })
  }

  const materiallyDegraded = input.rolloutHealth.deployments.filter(
    (deployment) =>
      deployment.status === 'degraded' && deployment.available_replicas < Math.max(1, deployment.desired_replicas),
  )

  if (materiallyDegraded.length > 0) {
    return buildLease({
      domain: 'rollout',
      scope: input.namespace,
      status: 'expired',
      actionClasses: ['dispatch_normal', 'deploy_widen', 'torghut_capital'],
      now: input.now,
      reasonCodes: ['rollout.replicas_unavailable'],
      evidenceRefs: materiallyDegraded.map((deployment) => `deployment:${deployment.namespace}:${deployment.name}`),
      rollbackTarget: 'roll back to last available controller/runtime replica set',
    })
  }

  if (input.rolloutHealth.status === 'degraded') {
    return buildLease({
      domain: 'rollout',
      scope: input.namespace,
      status: 'degraded',
      actionClasses: ['dispatch_normal', 'deploy_widen', 'torghut_capital'],
      now: input.now,
      reasonCodes: ['rollout.health_degraded'],
      evidenceRefs: input.rolloutHealth.deployments.map(
        (deployment) => `deployment:${deployment.namespace}:${deployment.name}`,
      ),
      rollbackTarget: 'hold widening until rollout health returns healthy',
    })
  }

  return buildLease({
    domain: 'rollout',
    scope: input.namespace,
    status: 'valid',
    actionClasses: ['dispatch_normal', 'deploy_widen', 'torghut_capital'],
    now: input.now,
    reasonCodes: [],
    evidenceRefs: input.rolloutHealth.deployments.map(
      (deployment) => `deployment:${deployment.namespace}:${deployment.name}`,
    ),
  })
}

const isConfigMapMissingEvent = (event: KubeGatewayEvent) => {
  const reason = normalizeText(event.reason)
  const message = normalizeText(event.message)
  return (
    (reason.includes('configmap') || message.includes('configmap')) &&
    (reason.includes('notfound') || message.includes('not found') || message.includes('missing'))
  )
}

const hasMountConflict = (event: KubeGatewayEvent) => {
  const message = normalizeText(event.message)
  return message.includes('mountvolume') && (message.includes('already exists') || message.includes('multi-attach'))
}

const workflowReasonCodes = (workflows: WorkflowsReliabilityStatus) =>
  workflows.top_failure_reasons.map((entry) => normalizeText(entry.reason))

const buildStorageLease = (input: FailureDomainLeaseSetInput): FailureDomainLease => {
  const mountConflictEvents = input.kubernetesEvidence.events.filter(hasMountConflict)

  if (mountConflictEvents.length > 0) {
    return buildLease({
      domain: 'storage',
      scope: input.namespace,
      status: 'expired',
      actionClasses: ['dispatch_normal', 'dispatch_repair'],
      now: input.now,
      reasonCodes: ['storage.mount_conflict'],
      evidenceRefs: mountConflictEvents.map(eventEvidenceRef),
      rollbackTarget: 'detach stale volume attachment before dispatching workspace-backed work',
    })
  }

  return buildLease({
    domain: 'storage',
    scope: input.namespace,
    status: 'valid',
    actionClasses: ['dispatch_normal', 'dispatch_repair'],
    now: input.now,
    reasonCodes: [],
    evidenceRefs: ['storage:no_recent_mount_conflicts'],
  })
}

const buildWorkflowArtifactLease = (input: FailureDomainLeaseSetInput): FailureDomainLease => {
  const configMapMissingEvents = input.kubernetesEvidence.events.filter(isConfigMapMissingEvent)
  const reasonCodes = workflowReasonCodes(input.workflows)
  const workflowReportedConfigMapMissing = reasonCodes.some(
    (reason) => reason.includes('configmap') && (reason.includes('notfound') || reason.includes('missing')),
  )

  if (configMapMissingEvents.length > 0 || workflowReportedConfigMapMissing) {
    return buildLease({
      domain: 'workflow_artifact',
      scope: input.namespace,
      status: 'expired',
      actionClasses: ['dispatch_normal'],
      now: input.now,
      reasonCodes: ['workflow_artifact.configmap_missing'],
      evidenceRefs: [
        ...configMapMissingEvents.map(eventEvidenceRef),
        ...(workflowReportedConfigMapMissing ? ['workflows:top_failure_reasons'] : []),
      ],
      rollbackTarget: 'recreate missing workflow input ConfigMap or rerun affected stage',
    })
  }

  if (input.workflows.data_confidence === 'unknown') {
    return buildLease({
      domain: 'workflow_artifact',
      scope: input.namespace,
      status: 'unknown',
      actionClasses: ['dispatch_normal'],
      now: input.now,
      reasonCodes: ['workflow_artifact.collection_unknown'],
      evidenceRefs: ['workflows:data_confidence'],
      rollbackTarget: 'restore workflow artifact read access before enforcing normal dispatch',
    })
  }

  return buildLease({
    domain: 'workflow_artifact',
    scope: input.namespace,
    status: input.workflows.data_confidence === 'degraded' ? 'degraded' : 'valid',
    actionClasses: ['dispatch_normal'],
    now: input.now,
    reasonCodes: input.workflows.data_confidence === 'degraded' ? ['workflow_artifact.collection_degraded'] : [],
    evidenceRefs: ['workflows:top_failure_reasons'],
  })
}

const buildNatsLease = (input: FailureDomainLeaseSetInput): FailureDomainLease => {
  const collaborationKit = input.runtimeKits.find((kit) => kit.kit_class === 'collaboration') ?? null
  if (!collaborationKit) {
    return buildLease({
      domain: 'nats',
      scope: input.namespace,
      status: 'unknown',
      actionClasses: ['dispatch_normal', 'dispatch_repair'],
      now: input.now,
      reasonCodes: ['nats.collaboration_runtime_kit_missing'],
      evidenceRefs: ['runtime_kits:collaboration'],
      rollbackTarget: 'restore collaboration runtime kit before enforcing NATS-backed dispatch',
    })
  }

  if (collaborationKit.decision !== 'healthy') {
    const reasonCodes =
      collaborationKit.reason_codes.length > 0 ? collaborationKit.reason_codes : ['nats.collaboration_runtime_degraded']
    return buildLease({
      domain: 'nats',
      scope: collaborationKit.subject_ref,
      status: collaborationKit.decision === 'blocked' ? 'expired' : 'degraded',
      actionClasses: ['dispatch_normal', 'dispatch_repair'],
      now: input.now,
      reasonCodes,
      evidenceRefs: [collaborationKit.runtime_kit_id],
      rollbackTarget: 'restore nats/codex-nats runtime tools or keep dispatch enforcement disabled',
    })
  }

  return buildLease({
    domain: 'nats',
    scope: collaborationKit.subject_ref,
    status: 'valid',
    actionClasses: ['dispatch_normal', 'dispatch_repair'],
    now: input.now,
    reasonCodes: [],
    evidenceRefs: [collaborationKit.runtime_kit_id],
  })
}

const buildSourceSchemaLease = (
  input: FailureDomainLeaseSetInput,
  databaseLease: FailureDomainLease,
): FailureDomainLease => {
  const consistency = input.database.migration_consistency

  if (consistency.status === 'healthy' && databaseLease.status === 'valid') {
    return buildLease({
      domain: 'source_schema',
      scope: input.service,
      status: 'valid',
      actionClasses: ['dispatch_normal', 'deploy_widen', 'merge_ready', 'torghut_capital'],
      now: input.now,
      reasonCodes: [],
      evidenceRefs: [`source_schema:latest_registered:${consistency.latest_registered ?? 'none'}`],
    })
  }

  if (consistency.status === 'healthy' && databaseLease.status !== 'valid') {
    return buildLease({
      domain: 'source_schema',
      scope: input.service,
      status: 'unknown',
      actionClasses: ['dispatch_normal', 'deploy_widen', 'merge_ready', 'torghut_capital'],
      now: input.now,
      reasonCodes: ['source_schema.database_unroutable'],
      evidenceRefs: [
        `source_schema:latest_registered:${consistency.latest_registered ?? 'none'}`,
        databaseLease.lease_id,
      ],
      rollbackTarget: 'restore database routability before treating source schema as authoritative',
    })
  }

  return buildLease({
    domain: 'source_schema',
    scope: input.service,
    status: consistency.status === 'unknown' ? 'unknown' : 'degraded',
    actionClasses: ['dispatch_normal', 'deploy_widen', 'merge_ready', 'torghut_capital'],
    now: input.now,
    reasonCodes: [
      consistency.status === 'unknown' ? 'source_schema.migration_state_unknown' : 'source_schema.migration_drift',
    ],
    evidenceRefs: [`source_schema:latest_registered:${consistency.latest_registered ?? 'none'}`],
    rollbackTarget: 'align source and applied migration registries before promotion',
  })
}

const requiredDomainsByAction: Record<FailureDomainActionClass, FailureDomainLeaseDomain[]> = {
  serve_readonly: ['route'],
  dispatch_normal: ['database', 'route', 'rollout', 'storage', 'workflow_artifact', 'nats', 'source_schema'],
  dispatch_repair: ['storage', 'nats'],
  deploy_widen: ['database', 'route', 'rollout', 'registry', 'source_schema'],
  merge_ready: ['database', 'source_schema'],
  torghut_observe: [],
  torghut_capital: ['database', 'route', 'rollout', 'source_schema'],
}

const buildHoldbackDecision = (
  actionClass: FailureDomainActionClass,
  leases: FailureDomainLease[],
): FailureDomainHoldbackDecision => {
  const requiredDomains = requiredDomainsByAction[actionClass]
  const requiredLeases = leases.filter((lease) => requiredDomains.includes(lease.domain))
  const missingDomains = requiredDomains.filter((domain) => !requiredLeases.some((lease) => lease.domain === domain))
  const blockingLeases = requiredLeases.filter((lease) => lease.status !== 'valid' && lease.status !== 'override')
  const reasonCodes = uniqueStrings([
    ...blockingLeases.flatMap((lease) => lease.reason_codes),
    ...missingDomains.map((domain) => `${domain}.lease_missing`),
  ])
  const leaseIds = requiredLeases.map((lease) => lease.lease_id)
  const decision = missingDomains.length > 0 ? 'unknown' : blockingLeases.length > 0 ? 'hold' : 'allow'
  const message =
    decision === 'allow'
      ? `${actionClass} is allowed by shadow failure-domain leases.`
      : `${actionClass} is held by ${reasonCodes.join(', ')}.`

  return {
    action_class: actionClass,
    decision,
    lease_ids: leaseIds,
    reason_codes: reasonCodes,
    message,
  }
}

export const buildFailureDomainLeaseSet = (input: FailureDomainLeaseSetInput): FailureDomainLeaseSet => {
  const databaseLease = buildDatabaseLease(input)
  const leases = [
    databaseLease,
    buildRouteLease(input),
    buildRolloutLease(input),
    buildRegistryLease(input),
    buildStorageLease(input),
    buildWorkflowArtifactLease(input),
    buildNatsLease(input),
    buildSourceSchemaLease(input, databaseLease),
  ]
  const holdbacks = (Object.keys(requiredDomainsByAction) as FailureDomainActionClass[]).map((actionClass) =>
    buildHoldbackDecision(actionClass, leases),
  )
  const digestInput = leases.map((lease) => ({
    domain: lease.domain,
    scope: lease.scope,
    status: lease.status,
    reason_codes: lease.reason_codes,
    expires_at: lease.expires_at,
  }))

  return {
    mode: 'shadow',
    design_artifact: FAILURE_DOMAIN_LEASES_DESIGN_ARTIFACT,
    lease_set_digest: `fdl-set:${hashJson(digestInput, 20)}`,
    generated_at: input.now.toISOString(),
    leases,
    holdbacks,
  }
}

const resolveRouteProbeUrl = ({ namespace, service, env = process.env }: FailureDomainRouteProbeInput) => {
  const explicitUrl = normalizeNonEmpty(env.JANGAR_CONTROL_PLANE_ROUTE_HEALTH_URL)
  if (explicitUrl) return explicitUrl

  const defaultProbeEnabled = parseBoolean(env.JANGAR_CONTROL_PLANE_ROUTE_PROBE_ENABLED, false)
  if (!defaultProbeEnabled) return null

  const routeNamespace =
    normalizeNonEmpty(env.JANGAR_CONTROL_PLANE_ROUTE_NAMESPACE) ??
    normalizeNonEmpty(env.JANGAR_POD_NAMESPACE) ??
    DEFAULT_APP_NAMESPACE
  const routeService = normalizeNonEmpty(env.JANGAR_CONTROL_PLANE_ROUTE_SERVICE) ?? service
  const routePath = normalizeNonEmpty(env.JANGAR_CONTROL_PLANE_ROUTE_HEALTH_PATH) ?? '/health'
  return `http://${routeService}.${routeNamespace || namespace}.svc.cluster.local${routePath.startsWith('/') ? routePath : `/${routePath}`}`
}

export const resolveFailureDomainRouteProbe = async (
  input: FailureDomainRouteProbeInput,
): Promise<FailureDomainRouteProbe> => {
  const observedAt = input.now.toISOString()
  const url = resolveRouteProbeUrl(input)
  if (!url) {
    return {
      status: 'healthy',
      reachable: true,
      url: null,
      status_code: null,
      latency_ms: 0,
      message: 'status route generated a response; external route probe is not configured',
      observed_at: observedAt,
    }
  }

  const timeoutMs = parsePositiveInt(input.env?.JANGAR_CONTROL_PLANE_ROUTE_PROBE_TIMEOUT_MS, ROUTE_PROBE_TIMEOUT_MS)
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), timeoutMs)
  const start = Date.now()

  try {
    const response = await fetch(url, {
      signal: controller.signal,
      headers: { accept: 'application/json' },
    })
    return {
      status: response.ok ? 'healthy' : 'degraded',
      reachable: response.ok,
      url,
      status_code: response.status,
      latency_ms: Math.max(0, Date.now() - start),
      message: response.ok ? 'route probe succeeded' : `route probe returned HTTP ${response.status}`,
      observed_at: observedAt,
    }
  } catch (error) {
    return {
      status: 'degraded',
      reachable: false,
      url,
      status_code: null,
      latency_ms: Math.max(0, Date.now() - start),
      message: normalizeErrorMessage(error),
      observed_at: observedAt,
    }
  } finally {
    clearTimeout(timeout)
  }
}

export const collectFailureDomainKubernetesEvidence = async ({
  namespace,
  kube,
  env = process.env,
}: FailureDomainKubernetesEvidenceInput): Promise<FailureDomainKubernetesEvidence> => {
  const configuredNamespaces = (normalizeNonEmpty(env.JANGAR_FAILURE_DOMAIN_EVIDENCE_NAMESPACES) ?? '')
    .split(',')
    .map((item) => item.trim())
    .filter((item) => item.length > 0)
  const namespaces = uniqueStrings([
    namespace,
    normalizeNonEmpty(env.JANGAR_CONTROL_PLANE_ROUTE_NAMESPACE) ?? DEFAULT_APP_NAMESPACE,
    ...configuredNamespaces,
  ])
  const evidence = emptyFailureDomainKubernetesEvidence()

  for (const currentNamespace of namespaces) {
    try {
      evidence.pods.push(...(await kube.listPods(currentNamespace)))
    } catch (error) {
      evidence.collection_errors.push(`${currentNamespace}: pods: ${normalizeErrorMessage(error)}`)
    }

    try {
      evidence.events.push(...(await kube.listEvents(currentNamespace)))
    } catch (error) {
      evidence.collection_errors.push(`${currentNamespace}: events: ${normalizeErrorMessage(error)}`)
    }
  }

  return evidence
}
