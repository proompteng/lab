import { createFileRoute, Link } from '@tanstack/react-router'
import * as React from 'react'

import {
  deriveStatusCategory,
  formatTimestamp,
  getMetadataValue,
  getResourceUpdatedAt,
  readNestedValue,
  StatusBadge,
  summarizeConditions,
} from '@/components/agents-control-plane'
import { DEFAULT_NAMESPACE, parseNamespaceSearch } from '@/components/agents-control-plane-search'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Textarea } from '@/components/ui/textarea'
import { fetchPrimitiveList, type PrimitiveResource } from '@/data/agents-control-plane'
import { cn } from '@/lib/utils'
import { randomUuid } from '@/lib/uuid'

export const Route = createFileRoute('/agents-control-plane/implementation-specs/')({
  validateSearch: parseNamespaceSearch,
  component: ImplementationSpecsPage,
})

type SpecDraft = {
  summary: string
  description: string
  text: string
  acceptanceCriteria: string[]
  labels: string[]
  requiredKeys: string[]
}

type CompletionPayload = {
  choices?: Array<{
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

const extractCompletionText = (payload: CompletionPayload) => {
  const choice = payload.choices?.[0]
  if (!choice?.message) return null
  const content = choice.message.content
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

function ImplementationSpecsPage() {
  const searchState = Route.useSearch()
  const navigate = Route.useNavigate()

  const [namespace, setNamespace] = React.useState(searchState.namespace)
  const [labelSelector, setLabelSelector] = React.useState(searchState.labelSelector ?? '')
  const [items, setItems] = React.useState<PrimitiveResource[]>([])
  const [total, setTotal] = React.useState(0)
  const [error, setError] = React.useState<string | null>(null)
  const [status, setStatus] = React.useState<string | null>(null)
  const [isLoading, setIsLoading] = React.useState(false)

  const [prompt, setPrompt] = React.useState('')
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

  const namespaceId = React.useId()
  const labelSelectorId = React.useId()
  const promptId = React.useId()

  React.useEffect(() => {
    setNamespace(searchState.namespace)
    setLabelSelector(searchState.labelSelector ?? '')
  }, [searchState.labelSelector, searchState.namespace])

  React.useEffect(() => {
    if (specNameTouched) return
    const nextName = slugifyName(specDraft.summary)
    if (nextName) setSpecName(nextName)
  }, [specDraft.summary, specNameTouched])

  const load = React.useCallback(async (params: { namespace: string; labelSelector?: string }) => {
    setIsLoading(true)
    setError(null)
    setStatus(null)
    try {
      const result = await fetchPrimitiveList({
        kind: 'ImplementationSpec',
        namespace: params.namespace,
        labelSelector: params.labelSelector,
      })
      if (!result.ok) {
        setItems([])
        setTotal(0)
        setError(result.message)
        return
      }
      setItems(result.items)
      setTotal(result.total)
      setStatus(result.items.length === 0 ? 'No implementation specs found.' : `Loaded ${result.items.length} specs.`)
    } catch (err) {
      setItems([])
      setTotal(0)
      setError(err instanceof Error ? err.message : 'Failed to load implementation specs')
    } finally {
      setIsLoading(false)
    }
  }, [])

  React.useEffect(() => {
    void load({ namespace: searchState.namespace, labelSelector: searchState.labelSelector })
  }, [load, searchState.labelSelector, searchState.namespace])

  const submit = (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    const nextNamespace = namespace.trim() || DEFAULT_NAMESPACE
    const nextLabelSelector = labelSelector.trim()
    void navigate({
      search: {
        namespace: nextNamespace,
        ...(nextLabelSelector.length > 0 ? { labelSelector: nextLabelSelector } : {}),
      },
    })
  }

  const markDraftDirty = () => {
    setSpecSaveStatus('idle')
    setSpecSaveError(null)
  }

  const generateSpec = async () => {
    const trimmed = prompt.trim()
    if (!trimmed) {
      setGenerationError('Describe the implementation you want to draft.')
      return
    }
    setGenerationError(null)
    setIsGenerating(true)
    try {
      const response = await fetch('/openai/v1/chat/completions', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          messages: [
            { role: 'system', content: SYSTEM_PROMPT },
            { role: 'user', content: trimmed },
          ],
        }),
      })
      const payload = (await response.json().catch(() => null)) as CompletionPayload | null
      if (!response.ok || !payload) {
        const errorMessage = payload?.error?.message
        throw new Error(errorMessage ?? response.statusText)
      }
      const content = extractCompletionText(payload)
      if (!content) {
        throw new Error('Model did not return content.')
      }
      const jsonCandidate = extractJsonFromText(content)
      if (!jsonCandidate) {
        throw new Error('Model did not return JSON. Edit the spec manually.')
      }
      const parsed = JSON.parse(jsonCandidate) as Record<string, unknown>
      const nextSpec = normalizeSpecDraft(parsed)
      setSpecDraft(nextSpec)
      setSpecNameTouched(false)
      setSpecSaveStatus('idle')
      setSpecSaveError(null)
    } catch (err) {
      setGenerationError(err instanceof Error ? err.message : 'Unable to generate spec')
    } finally {
      setIsGenerating(false)
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
    setSpecSaveStatus('saved')
    await load({ namespace: searchState.namespace, labelSelector: searchState.labelSelector })
  }

  const hasDraftContent = Boolean(specDraft.summary.trim() || specDraft.text.trim() || specDraft.description.trim())

  return (
    <main className="mx-auto w-full max-w-6xl space-y-6 p-6">
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div className="space-y-2">
          <p className="text-xs font-medium uppercase tracking-widest text-muted-foreground">Agents</p>
          <h1 className="text-lg font-semibold">Implementation specs</h1>
          <p className="text-xs text-muted-foreground">Create specs, then run them through Agent Studio.</p>
        </div>
        <div className="text-xs text-muted-foreground">
          <span className="tabular-nums">{total}</span> total
        </div>
      </header>

      <form className="flex flex-wrap items-end gap-2" onSubmit={submit}>
        <div className="flex min-w-0 flex-1 flex-col gap-1">
          <label className="text-xs font-medium text-foreground" htmlFor={namespaceId}>
            Namespace
          </label>
          <Input
            id={namespaceId}
            name="namespace"
            value={namespace}
            onChange={(event) => setNamespace(event.target.value)}
            placeholder="agents"
            autoComplete="off"
          />
        </div>
        <div className="flex min-w-0 flex-1 flex-col gap-1">
          <label className="text-xs font-medium text-foreground" htmlFor={labelSelectorId}>
            Label selector
          </label>
          <Input
            id={labelSelectorId}
            name="labelSelector"
            value={labelSelector}
            onChange={(event) => setLabelSelector(event.target.value)}
            placeholder="key=value"
            autoComplete="off"
          />
        </div>
        <Button type="submit" disabled={isLoading}>
          Filter
        </Button>
        <Button
          type="button"
          variant="outline"
          onClick={() => void load({ namespace: searchState.namespace, labelSelector: searchState.labelSelector })}
          disabled={isLoading}
        >
          Refresh
        </Button>
      </form>

      <section className="grid gap-6 lg:grid-cols-[1.1fr_1.9fr]">
        <div className="space-y-4 rounded-none border border-border bg-card p-5">
          <div className="space-y-1">
            <h2 className="text-sm font-semibold">Add ImplementationSpec</h2>
            <p className="text-xs text-muted-foreground">
              Draft a spec with Codex, edit it, and save it to the control plane.
            </p>
          </div>
          <div className="space-y-2">
            <label className="text-xs font-medium" htmlFor={promptId}>
              Prompt
            </label>
            <Textarea
              id={promptId}
              value={prompt}
              onChange={(event) => setPrompt(event.target.value)}
              rows={3}
              placeholder="Describe the implementation you need."
            />
            <Button type="button" onClick={() => void generateSpec()} disabled={isGenerating}>
              {isGenerating ? 'Generating...' : 'Generate spec'}
            </Button>
            {generationError ? <div className="text-xs text-destructive">{generationError}</div> : null}
          </div>
          <div className="grid gap-3">
            <div className="space-y-1">
              <label className="text-xs font-medium" htmlFor="spec-summary">
                Summary
              </label>
              <Input
                id="spec-summary"
                value={specDraft.summary}
                onChange={(event) => {
                  setSpecDraft((prev) => ({ ...prev, summary: event.target.value }))
                  markDraftDirty()
                }}
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
                  markDraftDirty()
                }}
              />
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
                  markDraftDirty()
                }}
                rows={6}
              />
            </div>
            <div className="space-y-1">
              <label className="text-xs font-medium" htmlFor="spec-criteria">
                Acceptance criteria
              </label>
              <Textarea
                id="spec-criteria"
                value={specDraft.acceptanceCriteria.join('\n')}
                onChange={(event) => {
                  setSpecDraft((prev) => ({ ...prev, acceptanceCriteria: coerceStringList(event.target.value) }))
                  markDraftDirty()
                }}
                rows={3}
              />
            </div>
            <details className="space-y-2">
              <summary className="cursor-pointer text-xs font-semibold uppercase tracking-widest text-muted-foreground">
                Advanced
              </summary>
              <div className="space-y-3">
                <div className="space-y-1">
                  <label className="text-xs font-medium" htmlFor="spec-description">
                    Description
                  </label>
                  <Textarea
                    id="spec-description"
                    value={specDraft.description}
                    onChange={(event) => {
                      setSpecDraft((prev) => ({ ...prev, description: event.target.value }))
                      markDraftDirty()
                    }}
                    rows={3}
                  />
                </div>
                <div className="space-y-1">
                  <label className="text-xs font-medium" htmlFor="spec-labels">
                    Labels
                  </label>
                  <Textarea
                    id="spec-labels"
                    value={specDraft.labels.join('\n')}
                    onChange={(event) => {
                      setSpecDraft((prev) => ({ ...prev, labels: coerceStringList(event.target.value) }))
                      markDraftDirty()
                    }}
                    rows={2}
                  />
                </div>
                <div className="space-y-1">
                  <label className="text-xs font-medium" htmlFor="spec-required-keys">
                    Contract required keys
                  </label>
                  <Textarea
                    id="spec-required-keys"
                    value={specDraft.requiredKeys.join('\n')}
                    onChange={(event) => {
                      setSpecDraft((prev) => ({ ...prev, requiredKeys: coerceStringList(event.target.value) }))
                      markDraftDirty()
                    }}
                    rows={2}
                  />
                </div>
              </div>
            </details>
          </div>
          <div className="flex flex-wrap items-center gap-3">
            <Button type="button" onClick={() => void saveSpec()} disabled={specSaveStatus === 'saving'}>
              {specSaveStatus === 'saving' ? 'Saving...' : 'Save ImplementationSpec'}
            </Button>
            {specSaveStatus === 'saved' ? <span className="text-xs text-muted-foreground">Saved.</span> : null}
          </div>
          {specSaveError ? <div className="text-xs text-destructive">{specSaveError}</div> : null}
          {hasDraftContent && specSaveStatus !== 'saved' ? (
            <div className="text-xs text-muted-foreground">Unsaved changes</div>
          ) : null}
        </div>

        <div className="space-y-2">
          {error ? (
            <div className="rounded-none border border-destructive/40 bg-destructive/10 p-3 text-xs text-destructive">
              {error}
            </div>
          ) : null}
          {status ? <div className="text-xs text-muted-foreground">{status}</div> : null}

          <div className="overflow-hidden rounded-none border bg-card">
            <table className="w-full text-xs">
              <thead className="border-b bg-muted/30 text-muted-foreground">
                <tr className="text-left uppercase tracking-widest">
                  <th className="px-3 py-2 font-medium">Spec</th>
                  <th className="px-3 py-2 font-medium">Summary</th>
                  <th className="px-3 py-2 font-medium">Source</th>
                  <th className="px-3 py-2 font-medium">Updated</th>
                  <th className="px-3 py-2 font-medium">Status</th>
                  <th className="px-3 py-2 font-medium text-right">Action</th>
                </tr>
              </thead>
              <tbody>
                {items.length === 0 && !isLoading ? (
                  <tr>
                    <td colSpan={6} className="px-3 py-6 text-center text-muted-foreground">
                      No implementation specs found in this namespace.
                    </td>
                  </tr>
                ) : (
                  items.map((resource) => {
                    const name = getMetadataValue(resource, 'name') ?? 'unknown'
                    const resourceNamespace = getMetadataValue(resource, 'namespace') ?? searchState.namespace
                    const summary = readNestedValue(resource, ['spec', 'summary']) ?? '—'
                    const source = readNestedValue(resource, ['spec', 'source', 'provider']) ?? '—'
                    const updatedAt = getResourceUpdatedAt(resource)
                    const statusLabel = deriveStatusCategory(resource)
                    const conditionSummary = summarizeConditions(resource)

                    return (
                      <tr key={`${resourceNamespace}/${name}`} className="border-b last:border-b-0">
                        <td className="px-3 py-2 font-medium text-foreground">
                          <div className="space-y-1">
                            <div>{name}</div>
                            <div className="text-[11px] text-muted-foreground">{resourceNamespace}</div>
                          </div>
                        </td>
                        <td className="px-3 py-2 text-muted-foreground">
                          <div className="max-w-[240px] truncate text-foreground">{summary}</div>
                        </td>
                        <td className="px-3 py-2 text-muted-foreground">{source}</td>
                        <td className="px-3 py-2 text-muted-foreground">{formatTimestamp(updatedAt)}</td>
                        <td className="px-3 py-2">
                          <div className="space-y-1">
                            <StatusBadge label={statusLabel} />
                            <div className="text-[10px] text-muted-foreground">{conditionSummary.summary}</div>
                          </div>
                        </td>
                        <td className="px-3 py-2 text-right">
                          <Link
                            to="/agents-control-plane"
                            search={{ namespace: resourceNamespace, spec: name }}
                            className={cn(
                              'inline-flex items-center justify-center rounded-none border border-border px-2 py-1 text-[10px] uppercase tracking-wide',
                              'text-muted-foreground transition hover:border-primary/40 hover:text-foreground',
                            )}
                          >
                            Use in studio
                          </Link>
                        </td>
                      </tr>
                    )
                  })
                )}
              </tbody>
            </table>
          </div>
        </div>
      </section>
    </main>
  )
}
