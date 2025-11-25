import type { Mission, MissionDetail, TimelineItem } from './types'

const sleep = (ms = 180) => new Promise((resolve) => setTimeout(resolve, ms))

const now = new Date('2025-11-24T05:30:00Z')

const makeTimestamp = (minutesAgo: number) => new Date(now.getTime() - minutesAgo * 60 * 1000).toISOString()

const timeline = (items: Omit<TimelineItem, 'id' | 'at'>[]): TimelineItem[] =>
  items.map((item, idx) => ({
    id: `${item.actor}-${idx}`,
    at: makeTimestamp(35 - idx * 4),
    ...item,
  }))

const missions: MissionDetail[] = [
  {
    id: 'ops-kit',
    title: 'Stabilize OpsKit rollout',
    summary: 'Track the rollout health checks and keep the worker PR green.',
    repo: 'github.com/proompteng/ops-kit',
    owner: 'Alex Rivera',
    tags: ['temporal', 'observability', 'codex'],
    status: 'running',
    progress: 0.64,
    updatedAt: makeTimestamp(4),
    eta: '15m',
    timeline: timeline([
      {
        actor: 'control-plane',
        label: 'Turn #4 completed',
        note: 'Meta Codex suggested rerunning flaky probe tests.',
        kind: 'message',
      },
      {
        actor: 'worker',
        label: 'PR checks running',
        note: 'bun test ./services/ops-kit --filter probes',
        kind: 'action',
      },
      {
        actor: 'operator',
        label: 'Pinned rollout window',
        note: 'Freeze deploy until health passes 3 consecutive runs.',
        kind: 'action',
      },
      {
        actor: 'control-plane',
        label: 'SSE heartbeat',
        note: 'Awaiting worker telemetry…',
        kind: 'message',
      },
    ]),
    pr: {
      title: 'Patch probe jitter for kservice readiness',
      branch: 'ops-kit/fix-probe-jitter',
      status: 'pending-review',
      reviewer: 'codeops',
      url: 'https://github.com/proompteng/ops-kit/pull/421',
    },
    logs: [
      {
        id: 'log-1',
        at: makeTimestamp(3),
        level: 'info',
        message: 'worker turn scheduled (depth=2, task=rollout-check)',
      },
      {
        id: 'log-2',
        at: makeTimestamp(2),
        level: 'warn',
        message: 'probe latency p95=2.4s exceeds SLO (1.8s)',
      },
      {
        id: 'log-3',
        at: makeTimestamp(1),
        level: 'info',
        message: 'replaying chat timeline for OpenWebUI shell',
      },
      {
        id: 'log-4',
        at: makeTimestamp(0),
        level: 'info',
        message: 'next SSE tick queued (every 5s)',
      },
    ],
  },
  {
    id: 'meta-orchestrator',
    title: 'Meta-orchestrator dry run',
    summary: 'Smoke-test orchestration loop against staging repo.',
    repo: 'github.com/proompteng/lab',
    owner: 'Morgan Chen',
    tags: ['workflow', 'staging'],
    status: 'pending',
    progress: 0.41,
    updatedAt: makeTimestamp(18),
    eta: '35m',
    timeline: timeline([
      {
        actor: 'operator',
        label: 'Started mission',
        note: 'Topic: "tighten lint + smoke tests" depth=2',
        kind: 'action',
      },
      {
        actor: 'control-plane',
        label: 'Turn #1 finished',
        note: 'Planner requested worker branch creation.',
        kind: 'message',
      },
      {
        actor: 'worker',
        label: 'Branch created',
        note: 'auto/meta-orchestrator-dry-run',
        kind: 'action',
      },
      {
        actor: 'control-plane',
        label: 'Awaiting operator message',
        note: 'UI should show OpenWebUI input once wired.',
        kind: 'message',
      },
    ]),
    pr: {
      title: 'Stub meta-orchestrator PR (dry run)',
      branch: 'auto/meta-orchestrator-dry-run',
      status: 'draft',
    },
    logs: [
      {
        id: 'log-5',
        at: makeTimestamp(16),
        level: 'info',
        message: 'temporal workflow started (runId=83b2)',
      },
      {
        id: 'log-6',
        at: makeTimestamp(12),
        level: 'info',
        message: 'codex meta-turn returned 14 items (plan + code diff)',
      },
      {
        id: 'log-7',
        at: makeTimestamp(9),
        level: 'info',
        message: 'worker delegate requested (repo clone pending)',
      },
    ],
  },
  {
    id: 'rollback-simulation',
    title: 'Rollback simulation for release train',
    summary: 'Replay failure path to keep runbooks fresh before prod cut.',
    repo: 'github.com/proompteng/release-train',
    owner: 'Priya Patel',
    tags: ['resilience', 'runbooks'],
    status: 'completed',
    progress: 1,
    updatedAt: makeTimestamp(60),
    timeline: timeline([
      {
        actor: 'control-plane',
        label: 'Mission completed',
        note: 'Awaiting manual verification note.',
        kind: 'message',
      },
      {
        actor: 'worker',
        label: 'PR merged',
        note: 'Rollback path validated against kservice',
        kind: 'action',
      },
    ]),
    pr: {
      title: 'Refresh rollback docs',
      branch: 'release/rollback-sim',
      status: 'merged',
      url: 'https://github.com/proompteng/release-train/pull/88',
    },
    logs: [
      {
        id: 'log-8',
        at: makeTimestamp(58),
        level: 'info',
        message: 'merged runbook updates into main',
      },
      {
        id: 'log-9',
        at: makeTimestamp(54),
        level: 'info',
        message: 'archived mission artifacts to bucket (stub)',
      },
    ],
  },
]

export const fetchMissions = async (): Promise<Mission[]> => {
  await sleep()
  return missions.map(({ timeline: _timeline, logs: _logs, pr: _pr, ...mission }) => ({ ...mission }))
}

export const fetchMissionById = async (id: string): Promise<MissionDetail> => {
  await sleep()
  const mission = missions.find((item) => item.id === id)

  if (!mission) {
    throw new Error('Mission not found')
  }

  // Return a shallow clone so route loaders can mutate safely.
  return {
    ...mission,
    timeline: mission.timeline.map((entry) => ({ ...entry })),
    logs: mission.logs.map((entry) => ({ ...entry })),
    pr: { ...mission.pr },
  }
}
