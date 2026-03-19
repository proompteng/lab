import type { RuntimeSnapshot, SymphonyConfig } from './types'

type SymphonyConfigOverrides = Omit<
  Partial<SymphonyConfig>,
  | 'tracker'
  | 'hooks'
  | 'worker'
  | 'agent'
  | 'codex'
  | 'server'
  | 'posthog'
  | 'instance'
  | 'target'
  | 'release'
  | 'health'
> & {
  tracker?: Partial<SymphonyConfig['tracker']>
  hooks?: Partial<SymphonyConfig['hooks']>
  worker?: Partial<SymphonyConfig['worker']>
  agent?: Partial<SymphonyConfig['agent']>
  codex?: Partial<SymphonyConfig['codex']>
  server?: Partial<SymphonyConfig['server']>
  posthog?: Partial<SymphonyConfig['posthog']>
  instance?: Partial<SymphonyConfig['instance']>
  target?: Partial<SymphonyConfig['target']>
  release?: Partial<SymphonyConfig['release']>
  health?: Partial<SymphonyConfig['health']>
}

export const makeTestConfig = (overrides: SymphonyConfigOverrides = {}): SymphonyConfig => ({
  workflowPath: overrides.workflowPath ?? '/tmp/WORKFLOW.md',
  tracker: {
    kind: overrides.tracker?.kind ?? 'linear',
    endpoint: overrides.tracker?.endpoint ?? 'https://api.linear.app/graphql',
    apiKey: overrides.tracker?.apiKey ?? 'token',
    projectSlug: overrides.tracker?.projectSlug ?? 'symphony',
    activeStates: overrides.tracker?.activeStates ?? ['Todo', 'In Progress'],
    terminalStates: overrides.tracker?.terminalStates ?? ['Done', 'Closed'],
    handoffState: overrides.tracker?.handoffState ?? 'Backlog',
  },
  pollingIntervalMs: overrides.pollingIntervalMs ?? 30_000,
  workspaceRoot: overrides.workspaceRoot ?? '/tmp/symphony',
  hooks: {
    afterCreate: overrides.hooks?.afterCreate ?? null,
    beforeRun: overrides.hooks?.beforeRun ?? null,
    afterRun: overrides.hooks?.afterRun ?? null,
    beforeRemove: overrides.hooks?.beforeRemove ?? null,
    timeoutMs: overrides.hooks?.timeoutMs ?? 60_000,
  },
  worker: {
    sshHosts: overrides.worker?.sshHosts ?? [],
    maxConcurrentAgentsPerHost: overrides.worker?.maxConcurrentAgentsPerHost ?? null,
  },
  agent: {
    maxConcurrentAgents: overrides.agent?.maxConcurrentAgents ?? 10,
    maxConcurrentAgentsByState: overrides.agent?.maxConcurrentAgentsByState ?? {},
    maxRetryBackoffMs: overrides.agent?.maxRetryBackoffMs ?? 300_000,
    maxTurns: overrides.agent?.maxTurns ?? 20,
  },
  codex: {
    command: overrides.codex?.command ?? 'codex app-server',
    approvalPolicy: overrides.codex?.approvalPolicy ?? 'never',
    threadSandbox: overrides.codex?.threadSandbox ?? 'workspace-write',
    turnSandboxPolicy: overrides.codex?.turnSandboxPolicy ?? null,
    turnTimeoutMs: overrides.codex?.turnTimeoutMs ?? 3_600_000,
    readTimeoutMs: overrides.codex?.readTimeoutMs ?? 5_000,
    stallTimeoutMs: overrides.codex?.stallTimeoutMs ?? 300_000,
  },
  server: {
    host: overrides.server?.host ?? '127.0.0.1',
    port: overrides.server?.port ?? null,
  },
  posthog: {
    enabled: overrides.posthog?.enabled ?? false,
    host: overrides.posthog?.host ?? 'http://posthog-events.posthog.svc.cluster.local:8000',
    apiKey: overrides.posthog?.apiKey ?? null,
    projectId: overrides.posthog?.projectId ?? null,
    distinctId: overrides.posthog?.distinctId ?? 'symphony:symphony',
    requestTimeoutMs: overrides.posthog?.requestTimeoutMs ?? 1_000,
    flushAt: overrides.posthog?.flushAt ?? 1,
    flushIntervalMs: overrides.posthog?.flushIntervalMs ?? 1_000,
  },
  instance: {
    name: overrides.instance?.name ?? 'symphony',
    namespace: overrides.instance?.namespace ?? 'jangar',
    argocdApplication: overrides.instance?.argocdApplication ?? 'symphony',
  },
  target: {
    name: overrides.target?.name ?? 'Symphony',
    namespace: overrides.target?.namespace ?? 'jangar',
    argocdApplication: overrides.target?.argocdApplication ?? 'symphony',
    repo: overrides.target?.repo ?? 'proompteng/lab',
    defaultBranch: overrides.target?.defaultBranch ?? 'main',
  },
  release: {
    mode: overrides.release?.mode ?? 'gitops_pr_on_main',
    requiredChecksSource: overrides.release?.requiredChecksSource ?? 'branch_protection',
    promotionBranchPrefix: overrides.release?.promotionBranchPrefix ?? 'codex/symphony-release-',
    blockedLabels: overrides.release?.blockedLabels ?? [
      'manual-only',
      'secret-rotation',
      'cluster-recovery',
      'cross-repo',
      'db-migration',
    ],
    deployables: overrides.release?.deployables ?? [
      {
        name: 'symphony',
        image: 'registry.ide-newton.ts.net/lab/symphony',
        manifestPaths: ['argocd/applications/symphony/kustomization.yaml'],
        buildWorkflow: 'symphony-build-push',
        releaseWorkflow: 'symphony-release',
        postDeployWorkflow: 'symphony-post-deploy-verify',
      },
    ],
  },
  health: {
    preDispatch: overrides.health?.preDispatch ?? [],
    postDeploy: overrides.health?.postDeploy ?? [],
  },
})

export const makeTestSnapshot = (): RuntimeSnapshot => ({
  generatedAt: '2026-03-14T12:00:00.000Z',
  counts: {
    running: 1,
    retrying: 1,
  },
  running: [
    {
      issueId: 'issue-1',
      issueIdentifier: 'ABC-1',
      state: 'In Progress',
      sessionId: 'thread-1-turn-1',
      turnCount: 3,
      lastEvent: 'turn_completed',
      lastMessage: 'Working on tests',
      startedAt: '2026-03-14T11:59:00.000Z',
      lastEventAt: '2026-03-14T11:59:30.000Z',
      tokens: {
        inputTokens: 100,
        outputTokens: 80,
        totalTokens: 180,
      },
    },
  ],
  retrying: [
    {
      issueId: 'issue-2',
      issueIdentifier: 'ABC-2',
      attempt: 2,
      dueAt: '2026-03-14T12:02:00.000Z',
      error: 'no available orchestrator slots',
    },
  ],
  codexTotals: {
    inputTokens: 400,
    outputTokens: 250,
    totalTokens: 650,
    secondsRunning: 123.4,
  },
  rateLimits: null,
  policy: {
    approvalPolicy: 'never',
    threadSandbox: 'workspace-write',
    turnSandboxPolicy: null,
    allowedTools: ['linear_graphql'],
    workspaceRoot: '/workspace/symphony',
    pollIntervalMs: 30_000,
    maxConcurrentAgents: 10,
    activeStates: ['Todo', 'In Progress'],
    terminalStates: ['Done', 'Closed'],
  },
  workflow: {
    workflowPath: '/etc/symphony/WORKFLOW.md',
    trackerKind: 'linear',
    projectSlug: 'symphony',
    promptTemplateEmpty: false,
  },
  instance: {
    name: 'symphony',
    namespace: 'jangar',
    argocdApplication: 'symphony',
  },
  target: {
    name: 'Symphony',
    namespace: 'jangar',
    argocdApplication: 'symphony',
    repo: 'proompteng/lab',
    defaultBranch: 'main',
  },
  release: {
    mode: 'gitops_pr_on_main',
    requiredChecksSource: 'branch_protection',
    promotionBranchPrefix: 'codex/symphony-release-',
    blockedLabels: ['manual-only'],
    deployables: [
      {
        name: 'symphony',
        image: 'registry.ide-newton.ts.net/lab/symphony',
        manifestPaths: ['argocd/applications/symphony/kustomization.yaml'],
        buildWorkflow: 'symphony-build-push',
        releaseWorkflow: 'symphony-release',
        postDeployWorkflow: 'symphony-post-deploy-verify',
      },
    ],
  },
  targetHealth: {
    checkedAt: '2026-03-14T11:59:59.000Z',
    readyForDispatch: true,
    openPromotionPr: false,
    promotionPrCount: 0,
    checks: [
      {
        name: 'symphony-argo',
        type: 'argocd_application',
        ok: true,
        message: 'synced=true health=Healthy',
        observed: 'Synced/Healthy',
      },
    ],
    lastError: null,
  },
  leader: {
    enabled: true,
    required: true,
    isLeader: true,
    leaseName: 'symphony-leader',
    leaseNamespace: 'jangar',
    identity: 'symphony-0_abc',
    lastTransitionAt: '2026-03-14T11:58:00.000Z',
    lastAttemptAt: '2026-03-14T11:59:59.000Z',
    lastSuccessAt: '2026-03-14T11:59:59.000Z',
    lastError: null,
  },
  telemetry: {
    enabled: true,
    host: 'http://posthog-events.posthog.svc.cluster.local:8000',
    projectId: '1',
    distinctId: 'symphony:symphony',
    lastError: null,
  },
  recentEvents: [
    {
      at: '2026-03-14T12:00:00.000Z',
      event: 'dispatch_skipped',
      message: 'issue ABC-2 not dispatched: no_slots',
      issueId: 'issue-2',
      issueIdentifier: 'ABC-2',
      level: 'warn',
      reason: 'no_slots',
    },
  ],
  recentErrors: [
    {
      at: '2026-03-14T11:58:45.000Z',
      code: 'worker_aborted',
      message: 'worker exited unexpectedly',
      issueId: 'issue-3',
      issueIdentifier: 'ABC-3',
      context: 'worker_exit',
    },
  ],
  capacity: {
    maxConcurrentAgents: 10,
    running: 1,
    retrying: 1,
    availableSlots: 9,
    saturated: false,
    byState: [{ state: 'in progress', running: 1, limit: 10, saturated: false }],
  },
})
