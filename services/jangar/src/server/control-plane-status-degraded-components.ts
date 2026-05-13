type NamedStatus = {
  name: string
  status: string
}

type RuntimeKitStatus = {
  kit_class: string
  decision: string
}

type WorkflowStatusFlags = readonly [
  isDataUnavailable: boolean,
  isWarning: boolean,
  isDegraded: boolean,
  isDataUnknown: boolean,
]

type EmpiricalServicesStatus = {
  forecast: { status: string }
  lean: { status: string }
  jobs: { status: string }
}

export const buildControlPlaneDegradedComponents = ({
  agentRunIngestion,
  database,
  effectiveControllers,
  effectiveRuntimeAdapters,
  empiricalServices,
  executionTrust,
  grpcStatus,
  rolloutHealth,
  runtimeKits,
  torghutConsumerEvidence,
  watchReliabilityStatus,
  workflowFlags,
}: {
  agentRunIngestion: { status: string }
  database: { status: string }
  effectiveControllers: NamedStatus[]
  effectiveRuntimeAdapters: NamedStatus[]
  empiricalServices: EmpiricalServicesStatus
  executionTrust: { executionTrust: { status: string } }
  grpcStatus: { enabled: boolean; status: string }
  rolloutHealth: { status: string }
  runtimeKits: RuntimeKitStatus[]
  torghutConsumerEvidence: { status: string }
  watchReliabilityStatus: { status: string }
  workflowFlags: WorkflowStatusFlags
}) => {
  const [isDataUnavailable, isWarning, isDegraded, isDataUnknown] = workflowFlags
  return [
    ...effectiveControllers
      .filter(
        (controller) =>
          controller.status === 'degraded' || controller.status === 'disabled' || controller.status === 'unknown',
      )
      .map((controller) => controller.name),
    ...effectiveRuntimeAdapters
      .filter((adapter) => adapter.name !== 'custom' && (adapter.status === 'degraded' || adapter.status === 'unknown'))
      .map((adapter) => `runtime:${adapter.name}`),
    ...(database.status === 'healthy' ? [] : ['database']),
    ...(grpcStatus.enabled && grpcStatus.status !== 'healthy' ? ['grpc'] : []),
    ...(watchReliabilityStatus.status === 'degraded' ? ['watch_reliability'] : []),
    ...(agentRunIngestion.status === 'degraded' ? ['agentrun_ingestion'] : []),
    ...(isDataUnavailable || isWarning || isDegraded ? ['workflows'] : []),
    ...(isDataUnknown || isDegraded ? ['runtime:workflows'] : []),
    ...(rolloutHealth.status === 'degraded' ? ['rollout_health'] : []),
    ...(empiricalServices.forecast.status === 'degraded' ? ['empirical:forecast'] : []),
    ...(empiricalServices.lean.status === 'degraded' ? ['empirical:lean'] : []),
    ...(empiricalServices.jobs.status === 'degraded' ? ['empirical:jobs'] : []),
    ...(torghutConsumerEvidence.status === 'unavailable' ? ['torghut_consumer_evidence'] : []),
    ...(executionTrust.executionTrust.status !== 'healthy' ? ['execution_trust'] : []),
    ...runtimeKits.filter((kit) => kit.decision !== 'healthy').map((kit) => `runtime_kit:${kit.kit_class}`),
  ]
}
