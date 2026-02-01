import { IconChevronRight } from '@tabler/icons-react'
import { createFileRoute, Link } from '@tanstack/react-router'
import * as React from 'react'

import { DEFAULT_NAMESPACE, parseNamespaceSearch } from '@/components/agents-control-plane-search'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Textarea } from '@/components/ui/textarea'
import { randomUuid } from '@/lib/uuid'

export const Route = createFileRoute('/agents-control-plane/implementation-specs/new')({
  validateSearch: parseNamespaceSearch,
  component: ImplementationSpecCreatePage,
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

const readStreamedCompletion = async (response: Response) => {
  if (!response.body) {
    throw new Error('Response body is unavailable.')
  }
  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  let output = ''
  let errorMessage: string | null = null

  const handleLine = (line: string) => {
    const trimmed = line.trim()
    if (!trimmed) return
    if (!trimmed.startsWith('data:')) return
    const payload = trimmed.replace(/^data:\s*/, '')
    if (!payload || payload === '[DONE]') return
    try {
      const parsed = JSON.parse(payload) as CompletionPayload
      if (parsed.error?.message) {
        errorMessage = parsed.error.message
        return
      }
      const delta = parsed.choices?.[0]?.delta?.content ?? parsed.choices?.[0]?.message?.content
      if (typeof delta === 'string') {
        output += delta
        return
      }
      const parts = parsed.choices?.[0]?.message?.content
      if (Array.isArray(parts)) {
        const next = parts
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
        output += next
      }
    } catch {
      // Ignore malformed stream fragments.
    }
  }

  while (true) {
    const { value, done } = await reader.read()
    if (done) break
    buffer += decoder.decode(value, { stream: true })
    const lines = buffer.split('\n')
    buffer = lines.pop() ?? ''
    for (const line of lines) handleLine(line)
  }
  if (buffer) handleLine(buffer)

  if (errorMessage) {
    throw new Error(errorMessage)
  }
  return output
}

function ImplementationSpecCreatePage() {
  const searchState = Route.useSearch()

  const [namespace, setNamespace] = React.useState(searchState.namespace)
  const resolvedNamespace = namespace.trim() || DEFAULT_NAMESPACE

  const [step, setStep] = React.useState<1 | 2 | 3>(1)

  const [prompt, setPrompt] = React.useState('')
  const [isGenerating, setIsGenerating] = React.useState(false)
  const [generationError, setGenerationError] = React.useState<string | null>(null)
  const [generationLog, setGenerationLog] = React.useState('')

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

  const promptId = React.useId()
  const namespaceId = React.useId()

  React.useEffect(() => {
    setNamespace(searchState.namespace)
  }, [searchState.namespace])

  React.useEffect(() => {
    if (specNameTouched) return
    const nextName = slugifyName(specDraft.summary)
    if (nextName) setSpecName(nextName)
  }, [specDraft.summary, specNameTouched])

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
          stream: true,
        }),
      })
      const contentType = response.headers.get('content-type') ?? ''
      const content =
        contentType.includes('text/event-stream') || contentType.includes('text/plain')
          ? await readStreamedCompletion(response)
          : await response
              .json()
              .then((payload: CompletionPayload) => {
                if (!response.ok) {
                  throw new Error(payload?.error?.message ?? response.statusText)
                }
                return extractCompletionText(payload) ?? ''
              })
              .catch((error) => {
                throw error instanceof Error ? error : new Error(response.statusText)
              })
      if (!content) {
        throw new Error('Model did not return content.')
      }
      setGenerationLog(content)
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
        namespace: resolvedNamespace,
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
    setStep(3)
  }

  const hasDraftContent = Boolean(specDraft.summary.trim() || specDraft.text.trim() || specDraft.description.trim())

  return (
    <main className="mx-auto w-full space-y-2 p-4">
      <header className="flex flex-wrap items-start justify-between gap-2">
        <div className="space-y-2">
          <h1 className="text-lg font-semibold">Create spec</h1>
          <p className="text-xs text-muted-foreground">Follow each step to draft and save an ImplementationSpec.</p>
        </div>
        <div className="flex flex-wrap items-center justify-end gap-2 text-xs text-muted-foreground">
          <span className="rounded-none border border-border px-2 py-0.5 text-[10px] font-semibold uppercase tracking-widest">
            Step {step} of 3
          </span>
          <span>{step === 1 ? 'Describe' : step === 2 ? 'Review & save' : 'Next steps'}</span>
        </div>
      </header>

      <div className="flex flex-wrap items-end gap-2">
        <div className="flex min-w-0 flex-1 flex-col gap-2">
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
      </div>

      {step === 1 ? (
        <section className="space-y-2">
          <div className="space-y-2">
            <label className="text-xs font-medium" htmlFor={promptId}>
              Prompt
            </label>
            <Textarea
              id={promptId}
              value={prompt}
              onChange={(event) => setPrompt(event.target.value)}
              rows={4}
              placeholder="Describe the implementation you need."
            />
            <div className="flex flex-wrap items-center gap-2">
              <Button type="button" variant="outline" onClick={() => void generateSpec()} disabled={isGenerating}>
                {isGenerating ? 'Generating...' : 'Generate spec'}
              </Button>
              <Button type="button" onClick={() => setStep(2)}>
                Next: review
              </Button>
            </div>
            {generationError ? <div className="text-xs text-destructive">{generationError}</div> : null}
            {generationLog ? (
              <details className="group rounded-none border border-border bg-background p-3">
                <summary className="flex cursor-pointer items-center gap-2 text-xs font-semibold uppercase tracking-widest text-muted-foreground">
                  <IconChevronRight className="size-3 transition-transform group-open:rotate-90" />
                  Generation log
                </summary>
                <pre className="mt-3 whitespace-pre-wrap text-[11px] text-foreground">{generationLog}</pre>
              </details>
            ) : null}
          </div>
        </section>
      ) : null}

      {step === 2 ? (
        <section className="space-y-2">
          <div className="space-y-2">
            <h2 className="text-sm font-semibold">Review & save</h2>
            <p className="text-xs text-muted-foreground">Edit the draft so it is clear and actionable.</p>
          </div>
          <div className="grid gap-2">
            <div className="grid gap-2 md:grid-cols-2">
              <div className="space-y-2">
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
              <div className="space-y-2">
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
            </div>
            <div className="space-y-2">
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
                rows={8}
              />
            </div>
            <div className="space-y-2">
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
                rows={4}
              />
            </div>
            <details className="space-y-2">
              <summary className="cursor-pointer text-xs font-semibold uppercase tracking-widest text-muted-foreground">
                Advanced
              </summary>
              <div className="space-y-2">
                <div className="space-y-2">
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
                <div className="space-y-2">
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
                <div className="space-y-2">
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
          <div className="flex flex-wrap items-center gap-2">
            <Button type="button" variant="outline" onClick={() => setStep(1)}>
              Back
            </Button>
            <Button type="button" onClick={() => void saveSpec()} disabled={specSaveStatus === 'saving'}>
              {specSaveStatus === 'saving' ? 'Saving...' : 'Save ImplementationSpec'}
            </Button>
            {specSaveStatus === 'saved' ? <span className="text-xs text-muted-foreground">Saved.</span> : null}
          </div>
          {specSaveError ? <div className="text-xs text-destructive">{specSaveError}</div> : null}
          {hasDraftContent && specSaveStatus !== 'saved' ? (
            <div className="text-xs text-muted-foreground">Unsaved changes</div>
          ) : null}
        </section>
      ) : null}

      {step === 3 ? (
        <section className="space-y-2">
          <div className="space-y-2">
            <h2 className="text-sm font-semibold">Spec saved</h2>
            <p className="text-xs text-muted-foreground">Continue to run the spec or return to the list.</p>
          </div>
          <div className="space-y-2 rounded-none border border-border bg-background p-3">
            <div className="text-xs font-medium">Spec</div>
            <div className="text-sm font-semibold">{specName || 'Unnamed spec'}</div>
            {specDraft.summary ? <div className="text-xs text-muted-foreground">{specDraft.summary}</div> : null}
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <Button asChild>
              <Link
                to="/agents-control-plane/implementation-specs/$name"
                params={{ name: specName }}
                search={{ namespace: resolvedNamespace }}
              >
                Run spec
              </Link>
            </Button>
            <Button variant="outline" asChild>
              <Link to="/agents-control-plane/implementation-specs" search={{ namespace: resolvedNamespace }}>
                Back to list
              </Link>
            </Button>
          </div>
        </section>
      ) : null}
    </main>
  )
}
