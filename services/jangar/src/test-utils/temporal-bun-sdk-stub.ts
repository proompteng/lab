export const temporalCallOptions = (options?: Record<string, unknown> | undefined) => options ?? {}

const defaultTemporalConfig = {
  host: 'temporal-frontend.temporal.svc.cluster.local',
  port: 7233,
  address: 'temporal-frontend.temporal.svc.cluster.local:7233',
  namespace: 'default',
}

export const loadTemporalConfig = async (options: { defaults?: Record<string, unknown> } = {}) => ({
  ...defaultTemporalConfig,
  ...(options.defaults ?? {}),
})

const createClient = () => ({
  workflow: {
    start: async () => ({ workflowId: 'workflow-id', namespace: 'default', runId: 'run-id' }),
    result: async () => ({ status: 'completed' }),
    describeNamespace: async () => ({}),
  },
  shutdown: async () => undefined,
})

export const createTemporalClient = async () => ({
  client: createClient(),
})

export const createWorker = async (_options: Record<string, unknown> = {}) => ({
  worker: {
    run: async () => undefined,
    shutdown: async () => undefined,
  },
  config: {
    address: defaultTemporalConfig.address,
    namespace: defaultTemporalConfig.namespace,
  },
})

export const VersioningBehavior = {
  AUTO_UPGRADE: 'AUTO_UPGRADE',
}
