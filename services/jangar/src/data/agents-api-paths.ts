const DEFAULT_AGENTS_PUBLIC_BASE_URL = 'https://agents.k8s.proompteng.ai'

const normalizeBaseUrl = (value: string | undefined) => {
  const trimmed = value?.trim()
  const baseUrl = trimmed || DEFAULT_AGENTS_PUBLIC_BASE_URL
  return baseUrl.endsWith('/') ? baseUrl.slice(0, -1) : baseUrl
}

export const AGENTS_PUBLIC_BASE_URL = normalizeBaseUrl(import.meta.env.VITE_AGENTS_PUBLIC_BASE_URL)
export const AGENTS_CONTROL_PLANE_API_BASE = `${AGENTS_PUBLIC_BASE_URL}/api/agents/control-plane` as const
export const AGENTS_EVENTS_API_PATH = `${AGENTS_PUBLIC_BASE_URL}/api/agents/events` as const
export const AGENTS_AGENT_RUNS_API_PATH = `${AGENTS_PUBLIC_BASE_URL}/v1/agent-runs` as const
