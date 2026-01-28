import { createFileRoute } from '@tanstack/react-router'

import { asRecord, asString, errorResponse, okResponse } from '~/server/primitives-http'
import { createKubernetesClient } from '~/server/primitives-kube'

type PodContainer = {
  name: string
  type: 'main' | 'init'
}

type AgentRunPod = {
  name: string
  phase: string | null
  containers: PodContainer[]
}

const parseTailLines = (value: string | null) => {
  if (!value) return null
  const parsed = Number(value)
  if (!Number.isFinite(parsed) || parsed <= 0) return null
  return Math.min(Math.floor(parsed), 5000)
}

const readContainerNames = (spec: Record<string, unknown>, key: 'containers' | 'initContainers') => {
  const entries = Array.isArray(spec[key]) ? spec[key] : []
  return entries
    .map((entry) => asString(asRecord(entry)?.name))
    .filter((name): name is string => Boolean(name))
}

const readPod = (item: Record<string, unknown>): AgentRunPod | null => {
  const metadata = asRecord(item.metadata) ?? {}
  const status = asRecord(item.status) ?? {}
  const spec = asRecord(item.spec) ?? {}
  const name = asString(metadata.name)
  if (!name) return null
  const containers = readContainerNames(spec, 'containers').map((entry) => ({ name: entry, type: 'main' as const }))
  const initContainers = readContainerNames(spec, 'initContainers').map((entry) => ({
    name: entry,
    type: 'init' as const,
  }))
  return {
    name,
    phase: asString(status.phase),
    containers: [...containers, ...initContainers],
  }
}

const pickDefaultPod = (pods: AgentRunPod[]) => pods.find((pod) => pod.phase === 'Running') ?? pods[0]

export const Route = createFileRoute('/api/agents/control-plane/logs')({
  server: {
    handlers: {
      GET: async ({ request }) => getAgentRunLogs(request),
    },
  },
})

export const getAgentRunLogs = async (
  request: Request,
  deps: { kubeClient?: ReturnType<typeof createKubernetesClient> } = {},
) => {
  const url = new URL(request.url)
  const name = asString(url.searchParams.get('name'))
  const namespace = asString(url.searchParams.get('namespace'))
  if (!name) {
    return errorResponse('name is required', 400)
  }
  if (!namespace) {
    return errorResponse('namespace is required', 400)
  }

  const podParam = asString(url.searchParams.get('pod'))
  const containerParam = asString(url.searchParams.get('container'))
  const tailLines = parseTailLines(url.searchParams.get('tailLines') ?? url.searchParams.get('tail_lines'))
  const kube = deps.kubeClient ?? createKubernetesClient()

  try {
    const list = await kube.list('pods', namespace, `agents.proompteng.ai/agent-run=${name}`)
    const items = Array.isArray(list.items) ? list.items : []
    const pods = items
      .map((item) => readPod(asRecord(item) ?? {}))
      .filter((pod): pod is AgentRunPod => Boolean(pod))

    if (pods.length === 0) {
      return okResponse({
        ok: true,
        name,
        namespace,
        pods: [],
        logs: '',
        pod: null,
        container: null,
        tailLines,
      })
    }

    const selectedPod = podParam ? pods.find((pod) => pod.name === podParam) : pickDefaultPod(pods)
    if (!selectedPod) {
      return errorResponse('pod not found', 404, { name, namespace, pod: podParam })
    }

    const containers = selectedPod.containers
    if (containers.length === 0) {
      return errorResponse('pod has no containers', 404, { name, namespace, pod: selectedPod.name })
    }

    const containerName =
      containerParam && containers.some((entry) => entry.name === containerParam)
        ? containerParam
        : containers.find((entry) => entry.type === 'main')?.name ?? containers[0]?.name ?? null

    if (!containerName) {
      return errorResponse('container not found', 404, { name, namespace, pod: selectedPod.name })
    }

    const logs = await kube.logs({ pod: selectedPod.name, namespace, container: containerName, tailLines })
    return okResponse({
      ok: true,
      name,
      namespace,
      pods,
      logs,
      pod: selectedPod.name,
      container: containerName,
      tailLines,
    })
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    return errorResponse(message, 500, { name, namespace })
  }
}
