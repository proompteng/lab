import { createFileRoute } from '@tanstack/react-router'
import { type AgentPrimitiveKind, resolvePrimitiveKind } from '~/server/primitives-control-plane'
import { asRecord, asString, normalizeNamespace, okResponse } from '~/server/primitives-http'
import { createKubernetesClient } from '~/server/primitives-kube'

export const Route = createFileRoute('/api/agents/control-plane/summary')({
  server: {
    handlers: {
      GET: async ({ request }) => getControlPlaneSummary(request),
    },
  },
})

const SUMMARY_KINDS: AgentPrimitiveKind[] = [
  'Agent',
  'AgentRun',
  'Orchestration',
  'OrchestrationRun',
  'ImplementationSpec',
  'ImplementationSource',
  'Memory',
  'Tool',
  'Signal',
  'Schedule',
  'Artifact',
  'Workspace',
]

const RUN_PHASES = ['Pending', 'Running', 'Succeeded', 'Failed', 'Cancelled'] as const

type RunPhase = (typeof RUN_PHASES)[number] | 'Unknown' | string

type SummaryEntry = {
  total: number
  error?: string
  phases?: Record<RunPhase, number>
}

const buildPhaseCounts = (): Record<RunPhase, number> => ({
  Pending: 0,
  Running: 0,
  Succeeded: 0,
  Failed: 0,
  Cancelled: 0,
  Unknown: 0,
})

const countRunPhases = (items: unknown[]): Record<RunPhase, number> => {
  const phases = buildPhaseCounts()

  for (const item of items) {
    const record = asRecord(item) ?? {}
    const status = asRecord(record.status) ?? {}
    const phase = asString(status.phase) ?? 'Unknown'
    if (!(phase in phases)) {
      phases[phase] = 0
    }
    phases[phase] += 1
  }

  return phases
}

export const getControlPlaneSummary = async (
  request: Request,
  deps: { kubeClient?: ReturnType<typeof createKubernetesClient> } = {},
) => {
  const url = new URL(request.url)
  const namespace = normalizeNamespace(url.searchParams.get('namespace'), 'agents')
  const kube = deps.kubeClient ?? createKubernetesClient()

  const resources = Object.fromEntries(
    await Promise.all(
      SUMMARY_KINDS.map(async (kind): Promise<[AgentPrimitiveKind, SummaryEntry]> => {
        const resolved = resolvePrimitiveKind(kind)
        if (!resolved) {
          return [kind, { total: 0, error: `Unknown kind: ${kind}` }]
        }

        try {
          const list = await kube.list(resolved.resource, namespace)
          const items = Array.isArray(list.items) ? list.items : []
          const entry: SummaryEntry = { total: items.length }
          if (resolved.kind === 'AgentRun' || resolved.kind === 'OrchestrationRun') {
            entry.phases = countRunPhases(items)
          }
          return [resolved.kind, entry]
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error)
          const entry: SummaryEntry = { total: 0, error: message }
          if (resolved.kind === 'AgentRun' || resolved.kind === 'OrchestrationRun') {
            entry.phases = buildPhaseCounts()
          }
          return [resolved.kind, entry]
        }
      }),
    ),
  ) as Record<AgentPrimitiveKind, SummaryEntry>

  return okResponse({ ok: true, namespace, resources })
}
