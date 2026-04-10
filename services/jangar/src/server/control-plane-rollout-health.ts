import { resolveControlPlaneStatusConfig } from '~/server/control-plane-config'
import { type KubeGateway, type KubeGatewayDeployment } from '~/server/kube-gateway'
import type {
  ControllerStatus,
  ControlPlaneRolloutHealth,
  DeploymentRolloutStatus,
  RuntimeAdapterStatus,
} from './control-plane-status-types'

const rolloutAuthority = (namespace: string, deploymentName: string, observedAt: string) => ({
  mode: 'rollout' as const,
  namespace,
  source_deployment: deploymentName,
  source_pod: '',
  observed_at: observedAt,
  fresh: true,
  message: `derived from healthy rollout for ${deploymentName}`,
})

const readRolloutDeploymentNames = () => resolveControlPlaneStatusConfig(process.env).rolloutDeployments

const safeDeploymentNumber = (value: unknown) => {
  if (typeof value === 'number' && Number.isFinite(value)) return Math.max(0, Math.floor(value))
  if (typeof value === 'string') {
    const parsed = Number.parseInt(value, 10)
    return Number.isFinite(parsed) ? Math.max(0, parsed) : 0
  }
  return 0
}

const buildDeploymentRolloutEntry = (deployment: KubeGatewayDeployment, namespace: string): DeploymentRolloutStatus => {
  const name = deployment.metadata.name
  const desiredReplicas = safeDeploymentNumber(deployment.spec.replicas)
  const readyReplicas = safeDeploymentNumber(deployment.status.readyReplicas)
  const availableReplicas = safeDeploymentNumber(deployment.status.availableReplicas)
  const updatedReplicas = safeDeploymentNumber(deployment.status.updatedReplicas)
  const unavailableReplicas = safeDeploymentNumber(deployment.status.unavailableReplicas)

  if (desiredReplicas === 0) {
    return {
      name,
      namespace,
      status: 'disabled',
      desired_replicas: desiredReplicas,
      ready_replicas: readyReplicas,
      available_replicas: availableReplicas,
      updated_replicas: updatedReplicas,
      unavailable_replicas: unavailableReplicas,
      message: 'scaled to zero replicas',
    }
  }

  const availableCondition = deployment.status.conditions.find((condition) => condition.type === 'Available') ?? null
  const progressingCondition =
    deployment.status.conditions.find((condition) => condition.type === 'Progressing') ?? null
  const availableConditionHealthy = (availableCondition?.status ?? '').toLowerCase() === 'true'
  const progressingConditionHealthy = (progressingCondition?.status ?? '').toLowerCase() === 'true'
  const isReplicaMismatch =
    readyReplicas < desiredReplicas ||
    availableReplicas < desiredReplicas ||
    updatedReplicas < desiredReplicas ||
    unavailableReplicas > 0

  const reasons: string[] = []
  if (!availableConditionHealthy) {
    reasons.push('available condition is false')
  }
  if (!progressingConditionHealthy) {
    reasons.push('progressing condition is not true')
  }
  if (isReplicaMismatch) {
    reasons.push(
      `replicas are behind: ready=${readyReplicas}, available=${availableReplicas}, updated=${updatedReplicas}, desired=${desiredReplicas}`,
    )
  }

  if (reasons.length === 0) {
    return {
      name,
      namespace,
      status: 'healthy',
      desired_replicas: desiredReplicas,
      ready_replicas: readyReplicas,
      available_replicas: availableReplicas,
      updated_replicas: updatedReplicas,
      unavailable_replicas: unavailableReplicas,
      message: 'deployment rollout healthy',
    }
  }

  return {
    name,
    namespace,
    status: 'degraded',
    desired_replicas: desiredReplicas,
    ready_replicas: readyReplicas,
    available_replicas: availableReplicas,
    updated_replicas: updatedReplicas,
    unavailable_replicas: unavailableReplicas,
    message: reasons.join('; '),
  }
}

export const unknownRolloutHealth = (): ControlPlaneRolloutHealth => ({
  status: 'unknown',
  observed_deployments: 0,
  degraded_deployments: 0,
  deployments: [],
  message: 'rollout health unavailable (kubernetes query failed)',
})

const findRolloutDeployment = (rolloutHealth: ControlPlaneRolloutHealth, namespace: string, name: string) =>
  rolloutHealth.deployments.find((deployment) => deployment.namespace === namespace && deployment.name === name) ?? null

const isAvailableSplitTopologyRollout = (
  deployment: DeploymentRolloutStatus | null,
): deployment is DeploymentRolloutStatus =>
  deployment != null &&
  (deployment.status === 'healthy' ||
    (deployment.status === 'degraded' && deployment.ready_replicas > 0 && deployment.available_replicas > 0))

export const hasMaterialRolloutDegradation = (rolloutHealth: ControlPlaneRolloutHealth) =>
  rolloutHealth.deployments.some((deployment) => {
    if (deployment.status !== 'degraded') return false

    const desiredReplicas = Math.max(deployment.desired_replicas, 1)
    return deployment.ready_replicas < desiredReplicas || deployment.available_replicas < desiredReplicas
  })

export const maybeUseSplitTopologyControllerRollout = ({
  namespace,
  now,
  controller,
  healthEnabled,
  rolloutHealth,
}: {
  namespace: string
  now: Date
  controller: ControllerStatus
  healthEnabled: boolean
  rolloutHealth: ControlPlaneRolloutHealth
}): ControllerStatus => {
  if (healthEnabled) return controller
  if (controller.status !== 'disabled' && controller.status !== 'unknown') return controller

  const controllersRollout = findRolloutDeployment(rolloutHealth, namespace, 'agents-controllers')
  if (!isAvailableSplitTopologyRollout(controllersRollout)) return controller

  return {
    ...controller,
    enabled: true,
    started: true,
    scope_namespaces: controller.scope_namespaces.length > 0 ? controller.scope_namespaces : [namespace],
    crds_ready: true,
    missing_crds: [],
    last_checked_at: now.toISOString(),
    status: 'healthy',
    message: `derived from available ${controllersRollout.name} rollout`,
    authority: rolloutAuthority(namespace, controllersRollout.name, now.toISOString()),
  }
}

export const maybeUseSplitTopologyRuntimeRollout = ({
  namespace,
  now,
  adapter,
  healthEnabled,
  rolloutHealth,
}: {
  namespace: string
  now: Date
  adapter: RuntimeAdapterStatus
  healthEnabled: boolean
  rolloutHealth: ControlPlaneRolloutHealth
}): RuntimeAdapterStatus => {
  if (healthEnabled) return adapter
  if (adapter.name !== 'workflow' && adapter.name !== 'job') return adapter
  if (adapter.status !== 'disabled' && adapter.status !== 'unknown') return adapter

  const controllersRollout = findRolloutDeployment(rolloutHealth, namespace, 'agents-controllers')
  if (!isAvailableSplitTopologyRollout(controllersRollout)) return adapter

  return {
    ...adapter,
    available: true,
    status: 'configured',
    message:
      adapter.name === 'workflow'
        ? `workflow runtime derived from available ${controllersRollout.name} rollout`
        : `job runtime derived from available ${controllersRollout.name} rollout`,
    authority: rolloutAuthority(namespace, controllersRollout.name, now.toISOString()),
  }
}

export const buildRolloutHealth = async ({
  namespace,
  kube,
}: {
  namespace: string
  kube: KubeGateway
}): Promise<ControlPlaneRolloutHealth> => {
  const names = readRolloutDeploymentNames()
  const items = await kube.listDeployments(namespace)
  const byName = new Map<string, KubeGatewayDeployment>()
  for (const item of items) {
    byName.set(item.metadata.name, item)
  }

  const deployments: DeploymentRolloutStatus[] = names.map((name) => {
    const deployment = byName.get(name)
    if (!deployment) {
      return {
        name,
        namespace,
        status: 'degraded',
        desired_replicas: 0,
        ready_replicas: 0,
        available_replicas: 0,
        updated_replicas: 0,
        unavailable_replicas: 0,
        message: `deployment ${name} not found in namespace ${namespace}`,
      }
    }
    return buildDeploymentRolloutEntry(deployment, namespace)
  })
  const degradedDeployments = deployments.filter((deployment) => deployment.status === 'degraded').length
  const isDegraded = degradedDeployments > 0

  return {
    status: isDegraded ? 'degraded' : 'healthy',
    observed_deployments: deployments.length,
    degraded_deployments: degradedDeployments,
    deployments,
    message: isDegraded
      ? `${degradedDeployments} configured deployment(s) degraded in rollout`
      : `${deployments.length} configured deployment(s) healthy`,
  }
}
