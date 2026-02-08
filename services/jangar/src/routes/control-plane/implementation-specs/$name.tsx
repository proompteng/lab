import {
  Button,
  Input,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Textarea,
} from '@proompteng/design/ui'
import { createFileRoute } from '@tanstack/react-router'
import * as React from 'react'
import { getMetadataValue, getResourceUpdatedAt } from '@/components/agents-control-plane'
import { parseNamespaceSearch } from '@/components/agents-control-plane-search'
import { fetchPrimitiveDetail, fetchPrimitiveList, type PrimitiveResource } from '@/data/agents-control-plane'
import { randomUuid } from '@/lib/uuid'

export const Route = createFileRoute('/control-plane/implementation-specs/$name')({
  validateSearch: parseNamespaceSearch,
  component: ImplementationSpecRunPage,
})

type SpecDraft = {
  summary: string
  description: string
  text: string
  acceptanceCriteria: string[]
  labels: string[]
  requiredKeys: string[]
}

type SpecOption = SpecDraft & {
  name: string
  namespace: string
  updatedAt: string | null
}

type AgentOption = {
  name: string
  provider: string | null
}

const DEFAULT_RUN_IMAGE = 'registry.ide-newton.ts.net/lab/codex-universal:latest'
const DEFAULT_STEP_NAME = 'implement'
const DEFAULT_BASE_BRANCH = 'main'
const ISSUE_AUTOMATION_MARKER = '<!-- codex:skip-automation -->'
const DEFAULT_CODEX_SECRET = 'codex-github-token'

const asRecord = (value: unknown): Record<string, unknown> | null =>
  value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : null

const asString = (value: unknown) => (typeof value === 'string' && value.trim().length > 0 ? value.trim() : null)
const asStringValue = (value: unknown) => {
  if (typeof value === 'number' && Number.isFinite(value)) return String(value)
  return asString(value)
}

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

const parseParametersInput = (input: string) => {
  const trimmed = input.trim()
  if (!trimmed) return { ok: true as const, value: undefined }
  try {
    const parsed = JSON.parse(trimmed) as Record<string, unknown>
    const output: Record<string, string> = {}
    for (const [key, value] of Object.entries(parsed)) {
      if (value == null) continue
      output[key] = String(value)
    }
    return { ok: true as const, value: output }
  } catch (error) {
    return {
      ok: false as const,
      error: error instanceof Error ? error.message : 'Parameters must be valid JSON',
    }
  }
}

const parseSecretsInput = (input: string) => {
  const entries = input
    .split(/[\s,]+/g)
    .map((item) => item.trim())
    .filter((item) => item.length > 0)
  return entries.length > 0 ? entries : undefined
}

const buildHeadBranch = (specName: string) => {
  if (!specName) return ''
  return `codex/${specName}`
}

const buildIssueHeadBranch = (issueNumber: string) => {
  const trimmed = issueNumber.trim()
  if (!trimmed) return ''
  const suffix = randomUuid().slice(0, 8)
  return `codex/issue-${trimmed}-${suffix}`
}

const buildIssueBody = (spec: SpecOption) => {
  const sections: string[] = []
  if (spec.summary) {
    sections.push(`## Summary\n${spec.summary}`)
  }
  if (spec.description) {
    sections.push(`## Description\n${spec.description}`)
  }
  if (spec.text) {
    sections.push(`## Requirements\n${spec.text}`)
  }
  if (spec.acceptanceCriteria.length > 0) {
    const criteria = spec.acceptanceCriteria.map((item) => `- ${item}`).join('\n')
    sections.push(`## Acceptance criteria\n${criteria}`)
  }
  sections.push(ISSUE_AUTOMATION_MARKER)
  return sections.filter(Boolean).join('\n\n')
}

function ImplementationSpecRunPage() {
  const params = Route.useParams()
  const searchState = Route.useSearch()

  const [specResource, setSpecResource] = React.useState<PrimitiveResource | null>(null)
  const [specError, setSpecError] = React.useState<string | null>(null)
  const [specLoading, setSpecLoading] = React.useState(false)

  const [agents, setAgents] = React.useState<AgentOption[]>([])
  const [agentLoading, setAgentLoading] = React.useState(false)
  const [agentError, setAgentError] = React.useState<string | null>(null)
  const [selectedAgent, setSelectedAgent] = React.useState('')

  const [workloadImage, setWorkloadImage] = React.useState(DEFAULT_RUN_IMAGE)
  const [workflowStep, setWorkflowStep] = React.useState(DEFAULT_STEP_NAME)
  const [ttlSeconds, setTtlSeconds] = React.useState('3600')
  const [parametersInput, setParametersInput] = React.useState('')
  const [secretsInput, setSecretsInput] = React.useState('')
  const [secretBindingRef, setSecretBindingRef] = React.useState('')
  const [secretsTouched, setSecretsTouched] = React.useState(false)
  const [secretBindingTouched, setSecretBindingTouched] = React.useState(false)

  const [repository, setRepository] = React.useState('')
  const [issueNumber, setIssueNumber] = React.useState('')
  const [issueTitle, setIssueTitle] = React.useState('')
  const [issueUrl, setIssueUrl] = React.useState('')
  const [baseBranch, setBaseBranch] = React.useState(DEFAULT_BASE_BRANCH)
  const [headBranch, setHeadBranch] = React.useState('')
  const [headBranchTouched, setHeadBranchTouched] = React.useState(false)
  const [freshPull, _setFreshPull] = React.useState(true)

  const [issueCreateStatus, setIssueCreateStatus] = React.useState<'idle' | 'creating' | 'created'>('idle')
  const [issueCreateError, setIssueCreateError] = React.useState<string | null>(null)

  const [runStatus, setRunStatus] = React.useState<'idle' | 'running' | 'done'>('idle')
  const [runError, setRunError] = React.useState<string | null>(null)
  const [runResult, setRunResult] = React.useState<{ name: string; namespace: string } | null>(null)

  const previousSpecRef = React.useRef<string | null>(null)

  const readRepositoryValue = React.useCallback(() => {
    if (typeof document === 'undefined') return ''
    const input = document.getElementById('run-repo') as HTMLInputElement | null
    return input?.value?.trim() ?? ''
  }, [])

  const syncRepositoryFromInput = React.useCallback(
    (value?: string) => {
      const nextValue = (value ?? readRepositoryValue()).trim()
      if (nextValue && nextValue !== repository) {
        setRepository(nextValue)
      }
    },
    [readRepositoryValue, repository],
  )

  React.useEffect(() => {
    if (repository.trim()) return
    let attempts = 0
    const timer = window.setInterval(() => {
      attempts += 1
      const value = readRepositoryValue()
      if (value) {
        setRepository(value)
        window.clearInterval(timer)
        return
      }
      if (attempts >= 120) {
        window.clearInterval(timer)
      }
    }, 250)
    return () => {
      window.clearInterval(timer)
    }
  }, [readRepositoryValue, repository])

  React.useEffect(() => {
    let isMounted = true
    const loadSpec = async () => {
      setSpecLoading(true)
      setSpecError(null)
      try {
        const result = await fetchPrimitiveDetail({
          kind: 'ImplementationSpec',
          name: params.name,
          namespace: searchState.namespace,
        })
        if (!result.ok) {
          if (isMounted) {
            setSpecResource(null)
            setSpecError(result.message)
          }
          return
        }
        if (isMounted) {
          setSpecResource(result.resource)
        }
      } catch (error) {
        if (isMounted) {
          setSpecResource(null)
          setSpecError(error instanceof Error ? error.message : 'Unable to load spec')
        }
      } finally {
        if (isMounted) setSpecLoading(false)
      }
    }
    void loadSpec()
    return () => {
      isMounted = false
    }
  }, [params.name, searchState.namespace])

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

  React.useEffect(() => {
    void loadAgents(searchState.namespace)
  }, [loadAgents, searchState.namespace])

  const selectedSpec = React.useMemo(() => {
    if (!specResource) return null
    const name = getMetadataValue(specResource, 'name') ?? params.name
    const resourceNamespace = getMetadataValue(specResource, 'namespace') ?? searchState.namespace
    return {
      ...normalizeSpecDraft(specResource),
      name,
      namespace: resourceNamespace,
      updatedAt: getResourceUpdatedAt(specResource),
    } satisfies SpecOption
  }, [params.name, searchState.namespace, specResource])

  React.useEffect(() => {
    if (!selectedSpec) return
    if (!baseBranch) {
      setBaseBranch(DEFAULT_BASE_BRANCH)
    }
    const previousSpecName = previousSpecRef.current
    if (previousSpecName && previousSpecName !== selectedSpec.name) {
      setIssueNumber('')
      setIssueUrl('')
      setIssueTitle(selectedSpec.summary)
      setIssueCreateStatus('idle')
      setIssueCreateError(null)
      setHeadBranchTouched(false)
    }
    const previousDefaultHead = previousSpecName ? buildHeadBranch(previousSpecName) : ''
    if ((!headBranch || headBranch === previousDefaultHead) && !headBranchTouched) {
      setHeadBranch(buildHeadBranch(selectedSpec.name))
    }
    if (!issueTitle && selectedSpec.summary) {
      setIssueTitle(selectedSpec.summary)
    }
    previousSpecRef.current = selectedSpec.name
  }, [baseBranch, headBranch, headBranchTouched, issueTitle, selectedSpec])

  const parsedParameters = React.useMemo(() => parseParametersInput(parametersInput), [parametersInput])
  const secretsList = React.useMemo(() => parseSecretsInput(secretsInput), [secretsInput])
  const selectedAgentOption = React.useMemo(
    () => agents.find((agent) => agent.name === selectedAgent) ?? null,
    [agents, selectedAgent],
  )
  const isCodexAgent = selectedAgentOption?.provider === 'codex'

  React.useEffect(() => {
    if (isCodexAgent) {
      if (!secretsTouched && !secretsInput.trim()) {
        setSecretsInput(DEFAULT_CODEX_SECRET)
      }
      if (!secretBindingTouched && !secretBindingRef.trim()) {
        setSecretBindingRef(DEFAULT_CODEX_SECRET)
      }
      return
    }
    if (!secretsTouched && secretsInput.trim() === DEFAULT_CODEX_SECRET) {
      setSecretsInput('')
    }
    if (!secretBindingTouched && secretBindingRef.trim() === DEFAULT_CODEX_SECRET) {
      setSecretBindingRef('')
    }
  }, [isCodexAgent, secretBindingRef, secretBindingTouched, secretsInput, secretsTouched])

  React.useEffect(() => {
    if (!repository.trim() || !issueNumber.trim() || issueUrl.trim()) return
    setIssueUrl(`https://github.com/${repository.trim()}/issues/${issueNumber.trim()}`)
  }, [issueNumber, issueUrl, repository])

  const metadataParameters = React.useMemo(() => {
    const output: Record<string, string> = {}
    if (repository.trim()) output.repository = repository.trim()
    if (issueNumber.trim()) output.issueNumber = issueNumber.trim()
    if (issueTitle.trim()) output.issueTitle = issueTitle.trim()
    if (issueUrl.trim()) output.issueUrl = issueUrl.trim()
    if (baseBranch.trim()) output.base = baseBranch.trim()
    if (headBranch.trim()) output.head = headBranch.trim()
    if (workflowStep.trim()) output.stage = workflowStep.trim()
    if (freshPull) output.freshPull = 'true'
    return output
  }, [baseBranch, freshPull, headBranch, issueNumber, issueTitle, issueUrl, repository, workflowStep])

  const mergedParameters = React.useMemo(() => {
    if (!parsedParameters.ok) return metadataParameters
    return { ...(parsedParameters.value ?? {}), ...metadataParameters }
  }, [metadataParameters, parsedParameters])

  const missingRequiredKeys = React.useMemo(() => {
    if (!selectedSpec) return []
    const derivedKeys = new Set(['prompt', 'issueTitle', 'issueBody', 'issueUrl', 'url'])
    return selectedSpec.requiredKeys.filter((key) => {
      if (derivedKeys.has(key)) return false
      const value = mergedParameters[key]
      return !value || value.trim().length === 0
    })
  }, [mergedParameters, selectedSpec])

  const missingRunMetadata = React.useMemo(() => {
    const missing: string[] = []
    if (!repository.trim()) missing.push('Repository')
    if (!issueNumber.trim()) missing.push('Issue number')
    if (!headBranch.trim()) missing.push('Head branch')
    return missing
  }, [headBranch, issueNumber, repository])
  const missingSecretBinding = Boolean(secretsList?.length) && !secretBindingRef.trim()

  const createIssue = async () => {
    setIssueCreateError(null)
    if (!selectedSpec) {
      setIssueCreateError('Spec is required to create an issue.')
      return
    }
    const repoValue = repository.trim()
    if (!repoValue) {
      setIssueCreateError('Repository is required to create an issue.')
      return
    }
    const titleValue = issueTitle.trim() || selectedSpec.summary || selectedSpec.name
    const bodyValue = buildIssueBody(selectedSpec)
    setIssueCreateStatus('creating')
    try {
      const response = await fetch('/api/github/issues', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          repository: repoValue,
          title: titleValue,
          body: bodyValue,
        }),
      })
      const payload = (await response.json().catch(() => null)) as Record<string, unknown> | null
      if (!response.ok) {
        setIssueCreateStatus('idle')
        setIssueCreateError(asString(payload?.error) ?? 'Unable to create issue')
        return
      }
      const issue = asRecord(payload?.issue) ?? {}
      const createdNumber = asStringValue(issue.number) ?? ''
      const createdTitle = asString(issue.title) ?? titleValue
      const createdUrl = asString(issue.url) ?? ''
      if (createdNumber) {
        setIssueNumber(createdNumber)
      }
      setIssueTitle(createdTitle)
      if (createdUrl) {
        setIssueUrl(createdUrl)
      }
      if (!headBranchTouched || headBranch === buildHeadBranch(selectedSpec.name)) {
        const nextHead = createdNumber ? buildIssueHeadBranch(createdNumber) : buildHeadBranch(selectedSpec.name)
        if (nextHead) setHeadBranch(nextHead)
      }
      setIssueCreateStatus('created')
    } catch (error) {
      setIssueCreateStatus('idle')
      setIssueCreateError(error instanceof Error ? error.message : 'Unable to create issue')
    }
  }

  const runAgent = async () => {
    setRunError(null)
    setRunResult(null)
    if (!selectedSpec) {
      setRunError('Spec is required to run.')
      return
    }
    if (!selectedAgent) {
      setRunError('Select an agent to run.')
      return
    }
    if (!workloadImage.trim()) {
      setRunError('Runner image is required for workflow runs.')
      return
    }
    if (!parsedParameters.ok) {
      setRunError(parsedParameters.error)
      return
    }
    if (missingRequiredKeys.length > 0) {
      setRunError(`Missing required metadata keys: ${missingRequiredKeys.join(', ')}`)
      return
    }
    if (missingRunMetadata.length > 0) {
      setRunError(`Missing required run metadata: ${missingRunMetadata.join(', ')}`)
      return
    }
    if (missingSecretBinding) {
      setRunError('Secret binding ref is required when secrets are provided.')
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
    setRunStatus('running')
    const deliveryId = randomUuid()
    const runtimeConfig = ttlValue != null ? { ttlSecondsAfterFinished: ttlValue } : undefined
    try {
      const response = await fetch('/v1/agent-runs', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'idempotency-key': deliveryId,
        },
        body: JSON.stringify({
          agentRef: { name: selectedAgent },
          namespace: selectedSpec.namespace,
          implementationSpecRef: { name: selectedSpec.name },
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
          parameters: mergedParameters,
          secrets: secretsList,
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
      setRunResult(runName ? { name: runName, namespace: selectedSpec.namespace } : null)
    } catch (error) {
      setRunStatus('idle')
      setRunError(error instanceof Error ? error.message : 'Unable to start agent run')
    }
  }

  return (
    <main className="mx-auto w-full space-y-2 p-4">
      <header className="flex flex-wrap items-start justify-between gap-2">
        <div className="space-y-2">
          <h1 className="text-lg font-semibold">Run spec</h1>
          <p className="text-xs text-muted-foreground">Launch an agent run for this spec.</p>
        </div>
      </header>

      {specLoading ? <div className="text-xs text-muted-foreground">Loading spec…</div> : null}
      {specError ? <div className="text-xs text-destructive">{specError}</div> : null}

      {selectedSpec ? (
        <section className="space-y-2 rounded-none border border-border bg-card p-4">
          <div className="flex flex-wrap items-start justify-between gap-2">
            <div className="space-y-2">
              <h2 className="text-sm font-semibold">Spec</h2>
              <p className="text-xs text-muted-foreground">{selectedSpec.name}</p>
            </div>
            {selectedSpec.updatedAt ? (
              <div className="text-[11px] text-muted-foreground">Updated {selectedSpec.updatedAt}</div>
            ) : null}
          </div>
          {selectedSpec.summary ? <div className="text-sm font-semibold">{selectedSpec.summary}</div> : null}
          {selectedSpec.description ? (
            <div className="text-xs whitespace-pre-wrap text-muted-foreground">{selectedSpec.description}</div>
          ) : null}
          <div className="space-y-2">
            <div className="text-xs font-semibold uppercase tracking-widest text-muted-foreground">Requirements</div>
            <div className="text-xs whitespace-pre-wrap text-foreground">
              {selectedSpec.text || 'No requirements provided.'}
            </div>
            {selectedSpec.acceptanceCriteria.length > 0 ? (
              <div className="space-y-1">
                <div className="text-xs font-medium text-foreground">Acceptance criteria</div>
                <ul className="list-disc space-y-1 pl-4 text-xs text-foreground">
                  {selectedSpec.acceptanceCriteria.map((item) => (
                    <li key={item}>{item}</li>
                  ))}
                </ul>
              </div>
            ) : null}
            {selectedSpec.requiredKeys.length > 0 ? (
              <div className="space-y-1">
                <div className="text-xs font-medium text-foreground">Required metadata</div>
                <div className="flex flex-wrap gap-2">
                  {selectedSpec.requiredKeys.map((key) => (
                    <span key={key} className="rounded-none border border-border px-2 py-0.5 text-[11px]">
                      {key}
                    </span>
                  ))}
                </div>
              </div>
            ) : null}
          </div>
        </section>
      ) : null}

      <section className="space-y-2 rounded-none border border-border bg-card p-4">
        <div className="space-y-2">
          <h2 className="text-sm font-semibold">Run configuration</h2>
          <p className="text-xs text-muted-foreground">
            Runs are locked to the latest main branch and always perform a fresh pull before execution.
          </p>
        </div>

        <div className="space-y-2">
          <div className="space-y-2">
            <label className="text-xs font-medium" htmlFor="run-agent">
              Agent
            </label>
            <Select value={selectedAgent} onValueChange={(value) => setSelectedAgent(value ?? '')}>
              <SelectTrigger id="run-agent" className="w-full">
                <SelectValue placeholder={agentLoading ? 'Loading agents…' : 'Select agent'} />
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
            {agents.length > 0 ? (
              <div className="flex flex-wrap gap-2 text-[11px] text-muted-foreground">
                {agents.map((agent) => (
                  <span key={agent.name} className="rounded-none border border-border px-2 py-0.5">
                    {agent.name}
                  </span>
                ))}
              </div>
            ) : null}
            <div className="text-[11px] text-muted-foreground">
              Create agents by applying Agent + AgentProvider resources in this namespace.
            </div>
          </div>

          <div className="space-y-2">
            <label className="text-xs font-medium" htmlFor="run-repo">
              Repository
            </label>
            <Input
              id="run-repo"
              value={repository}
              onChange={(event) => setRepository(event.target.value)}
              onBlur={(event) => syncRepositoryFromInput(event.currentTarget.value)}
              onFocus={() => syncRepositoryFromInput()}
              autoComplete="on"
              name="repository"
              placeholder="proompteng/lab"
            />
            <div className="flex flex-wrap items-center gap-2 text-[11px] text-muted-foreground">
              <Button
                type="button"
                variant="outline"
                onClick={() => void createIssue()}
                disabled={issueCreateStatus === 'creating' || !selectedSpec || !repository.trim()}
              >
                {issueCreateStatus === 'creating' ? 'Creating issue…' : 'Create GitHub issue'}
              </Button>
              {issueNumber ? <span>Issue #{issueNumber}</span> : null}
              {issueUrl ? (
                <a
                  className="underline decoration-dotted underline-offset-4"
                  href={issueUrl}
                  rel="noreferrer"
                  target="_blank"
                >
                  View issue
                </a>
              ) : null}
              {issueCreateStatus === 'created' && !issueNumber ? <span>Issue created.</span> : null}
            </div>
            {issueCreateError ? <div className="text-xs text-destructive">{issueCreateError}</div> : null}
          </div>

          <details className="space-y-2">
            <summary className="cursor-pointer text-xs font-semibold uppercase tracking-widest text-muted-foreground">
              Advanced run settings
            </summary>
            <div className="space-y-2">
              <div className="grid gap-2 md:grid-cols-2">
                <div className="space-y-2">
                  <label className="text-xs font-medium" htmlFor="run-issue-number">
                    Issue number
                  </label>
                  <Input
                    id="run-issue-number"
                    value={issueNumber}
                    onChange={(event) => setIssueNumber(event.target.value)}
                    placeholder="1234"
                  />
                </div>
                <div className="space-y-2">
                  <label className="text-xs font-medium" htmlFor="run-issue-title">
                    Issue title
                  </label>
                  <Input
                    id="run-issue-title"
                    value={issueTitle}
                    onChange={(event) => setIssueTitle(event.target.value)}
                    placeholder="Optional"
                  />
                </div>
                <div className="space-y-2">
                  <label className="text-xs font-medium" htmlFor="run-issue-url">
                    Issue URL
                  </label>
                  <Input
                    id="run-issue-url"
                    value={issueUrl}
                    onChange={(event) => setIssueUrl(event.target.value)}
                    placeholder="https://github.com/org/repo/issues/1234"
                  />
                </div>
                <div className="space-y-2">
                  <label className="text-xs font-medium" htmlFor="run-base">
                    Base branch
                  </label>
                  <Input
                    id="run-base"
                    value={baseBranch}
                    placeholder={DEFAULT_BASE_BRANCH}
                    readOnly
                    className="bg-muted/40 text-muted-foreground"
                  />
                </div>
                <div className="space-y-2">
                  <label className="text-xs font-medium" htmlFor="run-head">
                    Head branch
                  </label>
                  <Input
                    id="run-head"
                    value={headBranch}
                    onChange={(event) => {
                      setHeadBranch(event.target.value)
                      setHeadBranchTouched(true)
                    }}
                    placeholder={selectedSpec ? buildHeadBranch(selectedSpec.name) : 'codex/feature-branch'}
                  />
                </div>
                <div className="space-y-2">
                  <label className="text-xs font-medium" htmlFor="run-image">
                    Runner image
                  </label>
                  <Input
                    id="run-image"
                    value={workloadImage}
                    onChange={(event) => setWorkloadImage(event.target.value)}
                    placeholder={DEFAULT_RUN_IMAGE}
                  />
                </div>
                <div className="space-y-2">
                  <label className="text-xs font-medium" htmlFor="run-step">
                    Workflow step
                  </label>
                  <Input
                    id="run-step"
                    value={workflowStep}
                    onChange={(event) => setWorkflowStep(event.target.value)}
                    placeholder={DEFAULT_STEP_NAME}
                  />
                </div>
                <div className="space-y-2">
                  <label className="text-xs font-medium" htmlFor="run-ttl">
                    TTL seconds
                  </label>
                  <Input
                    id="run-ttl"
                    value={ttlSeconds}
                    onChange={(event) => setTtlSeconds(event.target.value)}
                    placeholder="3600"
                    inputMode="numeric"
                  />
                </div>
                <div className="flex items-center gap-2 pt-6 text-xs text-muted-foreground">
                  <input
                    id="run-fresh-pull"
                    type="checkbox"
                    className="size-4 accent-foreground"
                    checked={freshPull}
                    disabled
                  />
                  <label htmlFor="run-fresh-pull">Fresh pull from base before run (enforced)</label>
                </div>
              </div>
              <div className="space-y-2">
                <label className="text-xs font-medium" htmlFor="run-parameters">
                  Additional parameters (JSON)
                </label>
                <Textarea
                  id="run-parameters"
                  value={parametersInput}
                  onChange={(event) => setParametersInput(event.target.value)}
                  rows={4}
                  placeholder='{"prompt":"Extra context"}'
                />
                {!parsedParameters.ok ? <div className="text-xs text-destructive">{parsedParameters.error}</div> : null}
                {missingSecretBinding ? (
                  <div className="text-xs text-destructive">
                    Secret binding ref is required when secrets are provided.
                  </div>
                ) : null}
              </div>
              <div className="grid gap-2 md:grid-cols-2">
                <div className="space-y-2">
                  <label className="text-xs font-medium" htmlFor="run-secrets">
                    Secrets (comma separated)
                  </label>
                  <Input
                    id="run-secrets"
                    value={secretsInput}
                    onChange={(event) => {
                      setSecretsTouched(true)
                      setSecretsInput(event.target.value)
                    }}
                    placeholder="codex-github-token"
                  />
                </div>
                <div className="space-y-2">
                  <label className="text-xs font-medium" htmlFor="run-secret-binding">
                    Secret binding ref
                  </label>
                  <Input
                    id="run-secret-binding"
                    value={secretBindingRef}
                    onChange={(event) => {
                      setSecretBindingTouched(true)
                      setSecretBindingRef(event.target.value)
                    }}
                    placeholder="my-secret-binding"
                  />
                </div>
              </div>
            </div>
          </details>
        </div>

        {missingRequiredKeys.length > 0 ? (
          <div className="text-xs text-destructive">
            Missing required metadata keys: {missingRequiredKeys.join(', ')}
          </div>
        ) : null}
        {missingRunMetadata.length > 0 ? (
          <div className="text-xs text-destructive">Missing required run metadata: {missingRunMetadata.join(', ')}</div>
        ) : null}

        <div className="flex flex-wrap items-center gap-2">
          <Button
            type="button"
            onClick={() => void runAgent()}
            disabled={
              runStatus === 'running' ||
              !selectedSpec ||
              !selectedAgent ||
              !workloadImage.trim() ||
              !parsedParameters.ok ||
              missingRequiredKeys.length > 0 ||
              missingRunMetadata.length > 0 ||
              missingSecretBinding
            }
          >
            {runStatus === 'running' ? 'Starting…' : 'Run agent'}
          </Button>
          {runStatus === 'done' && runResult ? (
            <span className="text-xs text-muted-foreground">Run started: {runResult.name}</span>
          ) : null}
        </div>
        {runError ? <div className="text-xs text-destructive">{runError}</div> : null}
      </section>
    </main>
  )
}
