import { createFileRoute } from '@tanstack/react-router'
import * as React from 'react'

import { DEFAULT_NAMESPACE, parseNamespaceSearch } from '@/components/agents-control-plane-search'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Textarea } from '@/components/ui/textarea'
import { fetchPrimitiveList } from '@/data/agents-control-plane'
import { cn } from '@/lib/utils'
import { randomUuid } from '@/lib/uuid'

export const Route = createFileRoute('/agents-control-plane/')({
  validateSearch: parseNamespaceSearch,
  component: AgentStudioPage,
})

type ChatMessage = {
  role: 'user' | 'assistant'
  content: string
}

type SpecDraft = {
  summary: string
  description: string
  text: string
  acceptanceCriteria: string[]
  labels: string[]
  requiredKeys: string[]
}

type AgentOption = {
  name: string
  provider: string | null
}

type SpecOption = SpecDraft & {
  name: string
  namespace: string
  updatedAt: string | null
}

type CompletionMessage = {
  role: string
  content: string
}

type CompletionPayload = {
  choices?: Array<{
    delta?: { content?: string | Array<{ text?: string; content?: string }> | null } | string | null
    message?: { content?: string | Array<{ text?: string; content?: string }> | null } | null
  }>
  error?: { message?: string }
}

const SYSTEM_PROMPT = [
  'You write ImplementationSpec drafts for Jangar.',
  'Return ONLY a JSON object with these keys:',
  'summary, text, description, acceptanceCriteria, labels, contract.',
  'summary: short one-liner.',
  'text: the full spec text.',
  'acceptanceCriteria: array of short strings.',
  'labels: array of tags.',
  'contract: { requiredKeys: string[] } if metadata is required.',
  'Do not include markdown or code fences.',
].join(' ')

const DEFAULT_RUN_IMAGE = 'registry.ide-newton.ts.net/lab/codex-universal:latest'
const DEFAULT_STEP_NAME = 'implement'

const asRecord = (value: unknown): Record<string, unknown> | null =>
  value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : null

const asString = (value: unknown) => (typeof value === 'string' && value.trim().length > 0 ? value.trim() : null)

const coerceStringList = (value: unknown) => {
  if (Array.isArray(value)) {
    return value
      .filter((item): item is string => typeof item === 'string')
      .map((item) => item.trim())
      .filter((item) => item.length > 0)
  }
  if (typeof value === 'string') {
    return value
      .split(/[\n,]+/g)
      .map((item) => item.trim())
      .filter((item) => item.length > 0)
  }
  return []
}

const slugifyName = (value: string) => {
  const normalized = value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
  if (!normalized) return ''
  if (normalized.length <= 63) return normalized
  return normalized.slice(0, 63).replace(/-+$/g, '')
}

const extractJsonFromText = (value: string) => {
  const trimmed = value.trim()
  if (!trimmed) return null
  if (trimmed.startsWith('{') && trimmed.endsWith('}')) return trimmed
  const start = trimmed.indexOf('{')
  const end = trimmed.lastIndexOf('}')
  if (start >= 0 && end > start) {
    return trimmed.slice(start, end + 1)
  }
  return null
}

const normalizeSpecDraft = (value: Record<string, unknown>) => {
  const record = asRecord(value.spec) ?? value
  return {
    summary: asString(record.summary) ?? '',
    description: asString(record.description) ?? '',
    text: asString(record.text) ?? '',
    acceptanceCriteria: coerceStringList(record.acceptanceCriteria),
    labels: coerceStringList(record.labels),
    requiredKeys: coerceStringList(asRecord(record.contract)?.requiredKeys),
  } satisfies SpecDraft
}

const getSpecUpdatedAt = (resource: Record<string, unknown>) => {
  const status = asRecord(resource.status) ?? {}
  const metadata = asRecord(resource.metadata) ?? {}
  return (
    asString(status.updatedAt) ??
    asString(status.lastSyncedAt) ??
    asString(status.syncedAt) ??
    asString(metadata.creationTimestamp) ??
    null
  )
}

const formatTimestamp = (value: string | null) => {
  if (!value) return '—'
  const parsed = Date.parse(value)
  if (!Number.isFinite(parsed)) return value
  return new Intl.DateTimeFormat('en', {
    month: 'short',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  }).format(new Date(parsed))
}

const extractDeltaText = (payload: CompletionPayload) => {
  const choice = payload.choices?.[0]
  if (!choice) return null
  const delta = choice.delta ?? choice.message ?? null
  if (!delta) return null
  if (typeof delta === 'string') return delta
  const content = (delta as { content?: unknown }).content
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    return content
      .map((part) => {
        if (typeof part === 'string') return part
        if (part && typeof part === 'object') {
          const record = part as Record<string, unknown>
          if (typeof record.text === 'string') return record.text
          if (typeof record.content === 'string') return record.content
        }
        return ''
      })
      .join('')
  }
  return null
}

const streamChatCompletion = async (params: {
  messages: CompletionMessage[]
  onDelta: (chunk: string) => void
  signal?: AbortSignal
}) => {
  const response = await fetch('/openai/v1/chat/completions', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      messages: params.messages,
      stream: true,
    }),
    signal: params.signal,
  })

  if (!response.ok || !response.body) {
    const payload = await response.json().catch(() => null)
    const errorMessage = asString(asRecord(asRecord(payload)?.error)?.message)
    const message = errorMessage ?? response.statusText
    throw new Error(message || 'Unable to start completion')
  }

  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  let done = false

  while (!done) {
    const result = await reader.read()
    done = result.done
    buffer += decoder.decode(result.value ?? new Uint8Array(), { stream: !done })
    let boundary = buffer.indexOf('\n\n')
    while (boundary !== -1) {
      const chunk = buffer.slice(0, boundary)
      buffer = buffer.slice(boundary + 2)
      const lines = chunk.split('\n')
      for (const line of lines) {
        const trimmed = line.trim()
        if (!trimmed.startsWith('data:')) continue
        const data = trimmed.replace(/^data:\s*/, '')
        if (data === '[DONE]') {
          return
        }
        let payload: CompletionPayload | null = null
        try {
          payload = JSON.parse(data) as CompletionPayload
        } catch {
          continue
        }
        if (payload?.error?.message) {
          throw new Error(payload.error.message)
        }
        const deltaText = extractDeltaText(payload)
        if (deltaText) {
          params.onDelta(deltaText)
        }
      }
      boundary = buffer.indexOf('\n\n')
    }
  }
}

function AgentStudioPage() {
  const searchState = Route.useSearch()
  const navigate = Route.useNavigate()

  const [namespace, setNamespace] = React.useState(searchState.namespace)
  const [agents, setAgents] = React.useState<AgentOption[]>([])
  const [agentLoading, setAgentLoading] = React.useState(false)
  const [agentError, setAgentError] = React.useState<string | null>(null)
  const [selectedAgent, setSelectedAgent] = React.useState('')
  const [specs, setSpecs] = React.useState<SpecOption[]>([])
  const [specLoading, setSpecLoading] = React.useState(false)
  const [specError, setSpecError] = React.useState<string | null>(null)
  const [specFilter, setSpecFilter] = React.useState('')
  const [selectedSpecName, setSelectedSpecName] = React.useState('')

  const [prompt, setPrompt] = React.useState('')
  const [messages, setMessages] = React.useState<ChatMessage[]>([])
  const [assistantDraft, setAssistantDraft] = React.useState('')
  const [isGenerating, setIsGenerating] = React.useState(false)
  const [generationError, setGenerationError] = React.useState<string | null>(null)

  const [specDraft, setSpecDraft] = React.useState<SpecDraft>({
    summary: '',
    description: '',
    text: '',
    acceptanceCriteria: [],
    labels: [],
    requiredKeys: [],
  })
  const [specName, setSpecName] = React.useState('')
  const [specNameTouched, setSpecNameTouched] = React.useState(false)
  const [specSaveError, setSpecSaveError] = React.useState<string | null>(null)
  const [specSaveStatus, setSpecSaveStatus] = React.useState<'idle' | 'saving' | 'saved'>('idle')
  const [savedSpec, setSavedSpec] = React.useState<{ name: string; namespace: string } | null>(null)

  const [workloadImage, setWorkloadImage] = React.useState(DEFAULT_RUN_IMAGE)
  const [runStatus, setRunStatus] = React.useState<'idle' | 'running' | 'done'>('idle')
  const [runError, setRunError] = React.useState<string | null>(null)
  const [runResult, setRunResult] = React.useState<{ name: string; namespace: string } | null>(null)
  const [workflowStep, setWorkflowStep] = React.useState(DEFAULT_STEP_NAME)
  const [parametersInput, setParametersInput] = React.useState('')
  const [secretsInput, setSecretsInput] = React.useState('')
  const [secretBindingRef, setSecretBindingRef] = React.useState('')
  const [ttlSeconds, setTtlSeconds] = React.useState('3600')

  const abortRef = React.useRef<AbortController | null>(null)

  React.useEffect(() => {
    setNamespace(searchState.namespace)
  }, [searchState.namespace])

  const loadAgents = React.useCallback(
    async (nextNamespace: string) => {
      setAgentLoading(true)
      setAgentError(null)
      try {
        const result = await fetchPrimitiveList({ kind: 'Agent', namespace: nextNamespace, limit: 200 })
        if (!result.ok) {
          setAgents([])
          setAgentError(result.message)
          return
        }
        const options = result.items
          .map((item) => {
            const metadata = asRecord(item.metadata) ?? {}
            const spec = asRecord(item.spec) ?? {}
            const providerRef = asRecord(spec.providerRef) ?? {}
            const name = asString(metadata.name)
            if (!name) return null
            return { name, provider: asString(providerRef.name) } satisfies AgentOption
          })
          .filter((item): item is AgentOption => Boolean(item))
          .sort((a, b) => a.name.localeCompare(b.name))
        setAgents(options)
        if (!selectedAgent || !options.some((option) => option.name === selectedAgent)) {
          setSelectedAgent(options[0]?.name ?? '')
        }
      } catch (error) {
        setAgents([])
        setAgentError(error instanceof Error ? error.message : 'Unable to load agents')
      } finally {
        setAgentLoading(false)
      }
    },
    [selectedAgent],
  )

  const loadSpecs = React.useCallback(
    async (nextNamespace: string) => {
      setSpecLoading(true)
      setSpecError(null)
      try {
        const result = await fetchPrimitiveList({ kind: 'ImplementationSpec', namespace: nextNamespace, limit: 200 })
        if (!result.ok) {
          setSpecs([])
          setSpecError(result.message)
          return
        }
        const options = result.items
          .map((item) => {
            const metadata = asRecord(item.metadata) ?? {}
            const name = asString(metadata.name)
            if (!name) return null
            return {
              ...normalizeSpecDraft(item),
              name,
              namespace: nextNamespace,
              updatedAt: getSpecUpdatedAt(item),
            } satisfies SpecOption
          })
          .filter((item): item is SpecOption => Boolean(item))
          .sort((a, b) => {
            const aTime = a.updatedAt ? Date.parse(a.updatedAt) : 0
            const bTime = b.updatedAt ? Date.parse(b.updatedAt) : 0
            if (aTime !== bTime) return bTime - aTime
            return a.name.localeCompare(b.name)
          })
        setSpecs(options)
        if (selectedSpecName && !options.some((option) => option.name === selectedSpecName)) {
          setSelectedSpecName('')
          setSavedSpec(null)
          setSpecSaveStatus('idle')
        }
      } catch (error) {
        setSpecs([])
        setSpecError(error instanceof Error ? error.message : 'Unable to load specs')
      } finally {
        setSpecLoading(false)
      }
    },
    [selectedSpecName],
  )

  React.useEffect(() => {
    void loadAgents(searchState.namespace)
  }, [loadAgents, searchState.namespace])

  React.useEffect(() => {
    void loadSpecs(searchState.namespace)
  }, [loadSpecs, searchState.namespace])

  React.useEffect(() => {
    if (specNameTouched) return
    const nextName = slugifyName(specDraft.summary)
    if (nextName) setSpecName(nextName)
  }, [specDraft.summary, specNameTouched])

  React.useEffect(() => {
    return () => abortRef.current?.abort()
  }, [])

  const markSpecDirty = React.useCallback(() => {
    setSpecSaveStatus('idle')
    setSavedSpec(null)
    setSpecSaveError(null)
  }, [])

  const selectSpec = React.useCallback((spec: SpecOption) => {
    setSpecDraft({
      summary: spec.summary,
      description: spec.description,
      text: spec.text,
      acceptanceCriteria: spec.acceptanceCriteria,
      labels: spec.labels,
      requiredKeys: spec.requiredKeys,
    })
    setSpecName(spec.name)
    setSpecNameTouched(true)
    setSpecSaveStatus('saved')
    setSavedSpec({ name: spec.name, namespace: spec.namespace })
    setSpecSaveError(null)
    setSelectedSpecName(spec.name)
  }, [])

  const startNewSpec = React.useCallback(() => {
    setSpecDraft({
      summary: '',
      description: '',
      text: '',
      acceptanceCriteria: [],
      labels: [],
      requiredKeys: [],
    })
    setMessages([])
    setPrompt('')
    setAssistantDraft('')
    setGenerationError(null)
    setSpecName('')
    setSpecNameTouched(false)
    setSpecSaveStatus('idle')
    setSavedSpec(null)
    setSpecSaveError(null)
    setSelectedSpecName('')
  }, [])

  const filteredSpecs = React.useMemo(() => {
    const filter = specFilter.trim().toLowerCase()
    if (!filter) return specs
    return specs.filter(
      (spec) =>
        spec.name.toLowerCase().includes(filter) ||
        spec.summary.toLowerCase().includes(filter) ||
        spec.description.toLowerCase().includes(filter),
    )
  }, [specFilter, specs])

  const hasDraftContent = React.useMemo(
    () => Boolean(specDraft.summary.trim() || specDraft.description.trim() || specDraft.text.trim()),
    [specDraft],
  )

  const submitNamespace = (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    void navigate({
      search: {
        namespace: namespace.trim() || DEFAULT_NAMESPACE,
      },
    })
  }

  const startGeneration = async () => {
    const trimmed = prompt.trim()
    if (!trimmed) {
      setGenerationError('Describe the implementation you want to design.')
      return
    }
    abortRef.current?.abort()
    const controller = new AbortController()
    abortRef.current = controller
    setIsGenerating(true)
    setGenerationError(null)
    setAssistantDraft('')

    const nextMessages: ChatMessage[] = [...messages, { role: 'user', content: trimmed }]
    setMessages(nextMessages)

    let output = ''
    try {
      await streamChatCompletion({
        messages: [
          { role: 'system', content: SYSTEM_PROMPT },
          ...nextMessages.map((message) => ({ role: message.role, content: message.content })),
        ],
        onDelta: (chunk) => {
          output += chunk
          setAssistantDraft(output)
        },
        signal: controller.signal,
      })
    } catch (error) {
      if (error instanceof Error && error.name === 'AbortError') {
        setIsGenerating(false)
        return
      }
      setGenerationError(error instanceof Error ? error.message : 'Unable to generate spec')
      setIsGenerating(false)
      return
    }

    setIsGenerating(false)
    setMessages((prev) => [...prev, { role: 'assistant', content: output }])
    setAssistantDraft('')
    setPrompt('')

    const jsonCandidate = extractJsonFromText(output)
    if (!jsonCandidate) {
      setGenerationError('Model did not return JSON. Edit the spec manually.')
      return
    }
    try {
      const parsed = JSON.parse(jsonCandidate) as Record<string, unknown>
      const nextSpec = normalizeSpecDraft(parsed)
      if (!nextSpec.text) {
        setGenerationError('Spec text is required. Add it below before saving.')
      }
      setSpecDraft(nextSpec)
      setSpecNameTouched(false)
      setSpecSaveStatus('idle')
      setSavedSpec(null)
      setSpecSaveError(null)
      setSelectedSpecName('')
    } catch {
      setGenerationError('Failed to parse JSON. Edit the spec manually.')
    }
  }

  const saveSpec = async () => {
    setSpecSaveError(null)
    if (!specDraft.text.trim()) {
      setSpecSaveError('Spec text is required before saving.')
      return
    }
    if (!specName.trim()) {
      setSpecSaveError('Spec name is required.')
      return
    }
    setSpecSaveStatus('saving')
    const response = await fetch('/api/agents/control-plane/resource', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'idempotency-key': randomUuid(),
      },
      body: JSON.stringify({
        kind: 'ImplementationSpec',
        name: specName.trim(),
        namespace: searchState.namespace,
        spec: {
          summary: specDraft.summary.trim() || undefined,
          description: specDraft.description.trim() || undefined,
          text: specDraft.text.trim(),
          acceptanceCriteria: specDraft.acceptanceCriteria,
          labels: specDraft.labels,
          contract: specDraft.requiredKeys.length > 0 ? { requiredKeys: specDraft.requiredKeys } : undefined,
          source: { provider: 'manual' },
        },
      }),
    })

    const payload = (await response.json().catch(() => null)) as Record<string, unknown> | null
    if (!response.ok) {
      setSpecSaveStatus('idle')
      setSpecSaveError(asString(payload?.error) ?? 'Unable to save spec')
      return
    }
    const saved = { name: specName.trim(), namespace: searchState.namespace }
    setSpecSaveStatus('saved')
    setSavedSpec(saved)
    setSelectedSpecName(saved.name)
    void loadSpecs(searchState.namespace)
  }

  const parseParameters = () => {
    const trimmed = parametersInput.trim()
    if (!trimmed) return undefined
    try {
      const parsed = JSON.parse(trimmed) as Record<string, unknown>
      const output: Record<string, string> = {}
      for (const [key, value] of Object.entries(parsed)) {
        if (value == null) continue
        output[key] = String(value)
      }
      return Object.keys(output).length > 0 ? output : undefined
    } catch {
      throw new Error('Parameters must be valid JSON')
    }
  }

  const parseSecrets = () => {
    const entries = secretsInput
      .split(/[\s,]+/g)
      .map((item) => item.trim())
      .filter((item) => item.length > 0)
    return entries.length > 0 ? entries : undefined
  }

  const runAgent = async () => {
    setRunError(null)
    setRunResult(null)
    if (!selectedAgent) {
      setRunError('Select an agent to run.')
      return
    }
    if (!savedSpec) {
      setRunError('Select or save an ImplementationSpec before starting a run.')
      return
    }
    if (!workloadImage.trim()) {
      setRunError('Runner image is required for workflow runs.')
      return
    }
    const ttlRaw = ttlSeconds.trim()
    let ttlValue: number | undefined
    if (ttlRaw) {
      const parsed = Number.parseFloat(ttlRaw)
      if (!Number.isFinite(parsed) || parsed < 0) {
        setRunError('TTL must be a non-negative number.')
        return
      }
      ttlValue = parsed
    }
    let parameters: Record<string, string> | undefined
    try {
      parameters = parseParameters()
    } catch (error) {
      setRunError(error instanceof Error ? error.message : 'Invalid parameters')
      return
    }
    setRunStatus('running')
    const deliveryId = randomUuid()
    const runtimeConfig = ttlValue != null ? { ttlSecondsAfterFinished: ttlValue } : undefined
    const response = await fetch('/v1/agent-runs', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'idempotency-key': deliveryId,
      },
      body: JSON.stringify({
        agentRef: { name: selectedAgent },
        namespace: searchState.namespace,
        implementationSpecRef: { name: savedSpec.name },
        runtime: { type: 'workflow', config: runtimeConfig },
        workload: { image: workloadImage.trim() },
        workflow: {
          steps: [
            {
              name: workflowStep.trim() || DEFAULT_STEP_NAME,
              parameters: { stage: workflowStep.trim() || DEFAULT_STEP_NAME },
            },
          ],
        },
        parameters,
        secrets: parseSecrets(),
        policy: secretBindingRef.trim() ? { secretBindingRef: secretBindingRef.trim() } : undefined,
        ttlSecondsAfterFinished: ttlValue,
      }),
    })

    const payload = (await response.json().catch(() => null)) as Record<string, unknown> | null
    if (!response.ok) {
      setRunStatus('idle')
      setRunError(asString(payload?.error) ?? 'Unable to start agent run')
      return
    }
    const resource = asRecord(payload?.resource) ?? {}
    const metadata = asRecord(resource.metadata) ?? {}
    const runName = asString(metadata.name)
    setRunStatus('done')
    setRunResult(runName ? { name: runName, namespace: searchState.namespace } : null)
  }

  return (
    <main className="mx-auto w-full space-y-8 p-6">
      <header className="space-y-2">
        <p className="text-xs font-medium uppercase tracking-widest text-muted-foreground">Agents</p>
        <h1 className="text-xl font-semibold">Agent studio</h1>
        <p className="text-xs text-muted-foreground">
          Build an ImplementationSpec, save it, then pick an agent to execute the run.
        </p>
      </header>

      <form className="flex flex-wrap items-end gap-3" onSubmit={submitNamespace}>
        <div className="flex min-w-0 flex-1 flex-col gap-1">
          <label className="text-xs font-medium" htmlFor="studio-namespace">
            Namespace
          </label>
          <Input
            id="studio-namespace"
            name="namespace"
            value={namespace}
            onChange={(event) => setNamespace(event.target.value)}
            placeholder={DEFAULT_NAMESPACE}
            autoComplete="off"
          />
        </div>
        <Button type="submit" disabled={agentLoading || specLoading}>
          Use namespace
        </Button>
      </form>

      <div className="grid gap-6 lg:grid-cols-[1fr_2fr]">
        <aside className="space-y-6">
          <section className="space-y-4 rounded-none border border-border bg-card p-5">
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div className="space-y-1">
                <h2 className="text-sm font-semibold">Implementation specs</h2>
                <p className="text-xs text-muted-foreground">
                  {specLoading ? 'Loading specs...' : `${specs.length} saved specs in ${searchState.namespace}.`}
                </p>
              </div>
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() => void loadSpecs(searchState.namespace)}
                disabled={specLoading}
              >
                {specLoading ? 'Refreshing...' : 'Refresh'}
              </Button>
            </div>
            <Input
              value={specFilter}
              onChange={(event) => setSpecFilter(event.target.value)}
              placeholder="Filter specs"
            />
            {specError ? <div className="text-xs text-destructive">{specError}</div> : null}
            <div className="space-y-2">
              {filteredSpecs.length === 0 ? (
                <div className="text-xs text-muted-foreground">No specs saved yet.</div>
              ) : (
                filteredSpecs.map((spec) => {
                  const preview = spec.summary || spec.description || spec.text
                  const previewLine = preview ? preview.split('\n')[0] : 'No summary yet.'
                  const isActive = selectedSpecName === spec.name
                  return (
                    <button
                      key={spec.name}
                      type="button"
                      className={cn(
                        'flex w-full flex-col gap-2 rounded-none border px-3 py-2 text-left text-xs transition-colors',
                        isActive
                          ? 'border-primary/40 bg-primary/5'
                          : 'border-border bg-background hover:border-primary/30',
                      )}
                      onClick={() => selectSpec(spec)}
                    >
                      <div className="flex items-start justify-between gap-3">
                        <div className="space-y-1">
                          <div className="text-xs font-semibold">{spec.name}</div>
                          <div className="text-[11px] text-muted-foreground">{previewLine}</div>
                        </div>
                        {isActive ? (
                          <span className="text-[10px] font-semibold uppercase tracking-widest text-primary">
                            Active
                          </span>
                        ) : null}
                      </div>
                      {spec.updatedAt ? (
                        <div className="text-[11px] text-muted-foreground">
                          Updated {formatTimestamp(spec.updatedAt)}
                        </div>
                      ) : null}
                    </button>
                  )
                })
              )}
            </div>
            <div className="flex flex-wrap items-center gap-3">
              <Button type="button" variant="ghost" size="sm" onClick={startNewSpec}>
                New draft
              </Button>
              {selectedSpecName ? (
                <span className="text-xs text-muted-foreground">Selected: {selectedSpecName}</span>
              ) : null}
            </div>
          </section>

          <section className="space-y-2 rounded-none border border-border bg-card p-5">
            <div className="text-[10px] font-semibold uppercase tracking-widest text-muted-foreground">Run spec</div>
            <div className="text-sm font-semibold">{savedSpec?.name ?? 'No spec selected'}</div>
            <p className="text-xs text-muted-foreground">
              {savedSpec
                ? 'Runs will reference this ImplementationSpec.'
                : 'Select or save a spec to enable agent runs.'}
            </p>
            {specSaveStatus !== 'saved' && hasDraftContent ? (
              <div className="text-xs text-destructive">Unsaved changes</div>
            ) : null}
          </section>
        </aside>

        <div className="space-y-6">
          <section className="space-y-4 rounded-none border border-border bg-card p-5">
            <div className="space-y-1">
              <h2 className="text-sm font-semibold">1. Describe the implementation</h2>
              <p className="text-xs text-muted-foreground">
                Write what you want built. The assistant will return a structured ImplementationSpec.
              </p>
            </div>
            <Textarea
              value={prompt}
              onChange={(event) => setPrompt(event.target.value)}
              placeholder="Example: Build a CLI command that lists agents, summarizes their status, and prints run links."
              rows={4}
            />
            <div className="flex flex-wrap items-center gap-3">
              <Button type="button" onClick={() => void startGeneration()} disabled={isGenerating}>
                {isGenerating ? 'Generating...' : 'Generate spec'}
              </Button>
              <span className="text-xs text-muted-foreground">Uses Jangar completion API.</span>
            </div>
            {generationError ? <div className="text-xs text-destructive">{generationError}</div> : null}
            {messages.length > 0 || (isGenerating && assistantDraft) ? (
              <div className="space-y-3">
                {messages.map((message, index) => (
                  <div
                    key={`${message.role}-${index}`}
                    className="space-y-2 rounded-none border border-border bg-background p-3"
                  >
                    <div className="text-[10px] font-semibold uppercase tracking-widest text-muted-foreground">
                      {message.role === 'user' ? 'You' : 'Spec'}
                    </div>
                    <pre className="whitespace-pre-wrap text-xs text-foreground">{message.content}</pre>
                  </div>
                ))}
                {isGenerating && assistantDraft ? (
                  <div className="space-y-2 rounded-none border border-border bg-background p-3">
                    <div className="text-[10px] font-semibold uppercase tracking-widest text-muted-foreground">
                      Spec
                    </div>
                    <pre className="whitespace-pre-wrap text-xs text-foreground">{assistantDraft}</pre>
                  </div>
                ) : null}
              </div>
            ) : null}
          </section>

          <section className="space-y-4 rounded-none border border-border bg-card p-5">
            <div className="space-y-1">
              <h2 className="text-sm font-semibold">2. Review the spec</h2>
              <p className="text-xs text-muted-foreground">Edit the draft so it is clear and actionable.</p>
            </div>
            <div className="grid gap-4">
              <div className="grid gap-3 md:grid-cols-2">
                <div className="space-y-1">
                  <label className="text-xs font-medium" htmlFor="spec-summary">
                    Summary
                  </label>
                  <Input
                    id="spec-summary"
                    value={specDraft.summary}
                    onChange={(event) => {
                      setSpecDraft((prev) => ({ ...prev, summary: event.target.value }))
                      markSpecDirty()
                    }}
                    placeholder="Short one-line summary"
                  />
                </div>
                <div className="space-y-1">
                  <label className="text-xs font-medium" htmlFor="spec-name">
                    Spec name
                  </label>
                  <Input
                    id="spec-name"
                    value={specName}
                    onChange={(event) => {
                      setSpecName(event.target.value)
                      setSpecNameTouched(true)
                      setSelectedSpecName('')
                      markSpecDirty()
                    }}
                    placeholder="implementation-spec-name"
                  />
                </div>
              </div>
              <div className="space-y-1">
                <label className="text-xs font-medium" htmlFor="spec-text">
                  Spec text
                </label>
                <Textarea
                  id="spec-text"
                  value={specDraft.text}
                  onChange={(event) => {
                    setSpecDraft((prev) => ({ ...prev, text: event.target.value }))
                    markSpecDirty()
                  }}
                  rows={6}
                  placeholder="Full specification text"
                />
              </div>
              <div className="space-y-1">
                <label className="text-xs font-medium" htmlFor="spec-criteria">
                  Acceptance criteria (one per line)
                </label>
                <Textarea
                  id="spec-criteria"
                  value={specDraft.acceptanceCriteria.join('\n')}
                  onChange={(event) => {
                    setSpecDraft((prev) => ({ ...prev, acceptanceCriteria: coerceStringList(event.target.value) }))
                    markSpecDirty()
                  }}
                  rows={4}
                  placeholder="Example: CLI command returns exit code 0 on success."
                />
              </div>
            </div>
            <details className="space-y-3">
              <summary className="cursor-pointer text-xs font-semibold uppercase tracking-widest text-muted-foreground">
                Advanced fields
              </summary>
              <div className="grid gap-4">
                <div className="space-y-1">
                  <label className="text-xs font-medium" htmlFor="spec-description">
                    Description
                  </label>
                  <Textarea
                    id="spec-description"
                    value={specDraft.description}
                    onChange={(event) => {
                      setSpecDraft((prev) => ({ ...prev, description: event.target.value }))
                      markSpecDirty()
                    }}
                    rows={4}
                  />
                </div>
                <div className="space-y-1">
                  <label className="text-xs font-medium" htmlFor="spec-labels">
                    Labels (comma or newline)
                  </label>
                  <Textarea
                    id="spec-labels"
                    value={specDraft.labels.join('\n')}
                    onChange={(event) => {
                      setSpecDraft((prev) => ({ ...prev, labels: coerceStringList(event.target.value) }))
                      markSpecDirty()
                    }}
                    rows={3}
                  />
                </div>
                <div className="space-y-1">
                  <label className="text-xs font-medium" htmlFor="spec-required-keys">
                    Contract required keys (one per line)
                  </label>
                  <Textarea
                    id="spec-required-keys"
                    value={specDraft.requiredKeys.join('\n')}
                    onChange={(event) => {
                      setSpecDraft((prev) => ({ ...prev, requiredKeys: coerceStringList(event.target.value) }))
                      markSpecDirty()
                    }}
                    rows={3}
                  />
                </div>
              </div>
            </details>
            <div className="flex flex-wrap items-center gap-3">
              <Button type="button" onClick={() => void saveSpec()} disabled={specSaveStatus === 'saving'}>
                {specSaveStatus === 'saving' ? 'Saving...' : 'Save ImplementationSpec'}
              </Button>
              {specSaveStatus === 'saved' && savedSpec ? (
                <span className="text-xs text-muted-foreground">Saved as {savedSpec.name}</span>
              ) : null}
            </div>
            {specSaveError ? <div className="text-xs text-destructive">{specSaveError}</div> : null}
          </section>

          <section className="space-y-4 rounded-none border border-border bg-card p-5">
            <div className="space-y-1">
              <h2 className="text-sm font-semibold">3. Launch an agent run</h2>
              <p className="text-xs text-muted-foreground">
                Choose an agent and start a workflow run using this specification.
              </p>
            </div>
            <div className="grid gap-4 md:grid-cols-2">
              <div className="space-y-1">
                <label className="text-xs font-medium" htmlFor="studio-agent">
                  Agent
                </label>
                <Select value={selectedAgent} onValueChange={(value) => setSelectedAgent(value ?? '')}>
                  <SelectTrigger id="studio-agent" className="w-full">
                    <SelectValue placeholder={agentLoading ? 'Loading agents...' : 'Select agent'} />
                  </SelectTrigger>
                  <SelectContent>
                    {agents.length === 0 ? (
                      <SelectItem value="none" disabled>
                        No agents found
                      </SelectItem>
                    ) : null}
                    {agents.map((agent) => (
                      <SelectItem key={agent.name} value={agent.name}>
                        <span>{agent.name}</span>
                        {agent.provider ? <span className="text-muted-foreground">{agent.provider}</span> : null}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                {agentError ? <div className="text-xs text-destructive">{agentError}</div> : null}
              </div>
              <div className="space-y-1">
                <label className="text-xs font-medium" htmlFor="studio-image">
                  Runner image
                </label>
                <Input
                  id="studio-image"
                  value={workloadImage}
                  onChange={(event) => setWorkloadImage(event.target.value)}
                  placeholder={DEFAULT_RUN_IMAGE}
                />
              </div>
              <div className="space-y-1">
                <label className="text-xs font-medium" htmlFor="studio-step">
                  Workflow step name
                </label>
                <Input
                  id="studio-step"
                  value={workflowStep}
                  onChange={(event) => setWorkflowStep(event.target.value)}
                  placeholder={DEFAULT_STEP_NAME}
                />
              </div>
              <div className="space-y-1">
                <label className="text-xs font-medium" htmlFor="studio-ttl">
                  TTL seconds
                </label>
                <Input
                  id="studio-ttl"
                  value={ttlSeconds}
                  onChange={(event) => setTtlSeconds(event.target.value)}
                  placeholder="3600"
                  inputMode="numeric"
                />
              </div>
            </div>
            <details className="space-y-3">
              <summary className="cursor-pointer text-xs font-semibold uppercase tracking-widest text-muted-foreground">
                Advanced run settings
              </summary>
              <div className="grid gap-4">
                <div className="space-y-1">
                  <label className="text-xs font-medium" htmlFor="studio-parameters">
                    Parameters (JSON)
                  </label>
                  <Textarea
                    id="studio-parameters"
                    value={parametersInput}
                    onChange={(event) => setParametersInput(event.target.value)}
                    rows={4}
                    placeholder='{"repository":"proompteng/lab","issueNumber":"1234"}'
                  />
                </div>
                <div className="grid gap-3 md:grid-cols-2">
                  <div className="space-y-1">
                    <label className="text-xs font-medium" htmlFor="studio-secrets">
                      Secrets (comma separated)
                    </label>
                    <Input
                      id="studio-secrets"
                      value={secretsInput}
                      onChange={(event) => setSecretsInput(event.target.value)}
                      placeholder="codex-github-token"
                    />
                  </div>
                  <div className="space-y-1">
                    <label className="text-xs font-medium" htmlFor="studio-secret-binding">
                      Secret binding ref
                    </label>
                    <Input
                      id="studio-secret-binding"
                      value={secretBindingRef}
                      onChange={(event) => setSecretBindingRef(event.target.value)}
                      placeholder="my-secret-binding"
                    />
                  </div>
                </div>
              </div>
            </details>
            <div className="flex flex-wrap items-center gap-3">
              <Button type="button" onClick={() => void runAgent()} disabled={runStatus === 'running' || !savedSpec}>
                {runStatus === 'running' ? 'Starting...' : 'Run agent'}
              </Button>
              {savedSpec ? (
                <span className="text-xs text-muted-foreground">Using {savedSpec.name}</span>
              ) : (
                <span className="text-xs text-muted-foreground">Select a spec to enable runs.</span>
              )}
            </div>
            {runError ? <div className="text-xs text-destructive">{runError}</div> : null}
            {runStatus === 'done' && runResult ? (
              <div className="text-xs text-muted-foreground">Run started: {runResult.name}</div>
            ) : null}
          </section>
        </div>
      </div>

      <div className={cn('text-xs text-muted-foreground', isGenerating ? 'opacity-70' : '')}>
        Tip: keep specs concise and add missing context in the parameters JSON.
      </div>
    </main>
  )
}
