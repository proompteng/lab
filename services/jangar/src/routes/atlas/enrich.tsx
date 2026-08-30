import { Button, Input } from '@proompteng/design/ui'
import { createFileRoute } from '@tanstack/react-router'
import * as React from 'react'

import { enrichAtlasRepository } from '@/data/atlas'

type AtlasEnrichState = {
  repository: string
  commit: string
}

export const Route = createFileRoute('/atlas/enrich')({
  validateSearch: (search: Record<string, unknown>): AtlasEnrichState => ({
    repository: typeof search.repository === 'string' ? search.repository : '',
    commit: typeof search.commit === 'string' ? search.commit : '',
  }),
  component: AtlasEnrichPage,
})

function AtlasEnrichPage() {
  const searchState = Route.useSearch()
  const [repository, setRepository] = React.useState(searchState.repository || 'proompteng/lab')
  const [commit, setCommit] = React.useState(searchState.commit)
  const [error, setError] = React.useState<string | null>(null)
  const [status, setStatus] = React.useState<string | null>(null)
  const [submitting, setSubmitting] = React.useState(false)
  const repositoryRef = React.useRef<HTMLInputElement | null>(null)

  React.useEffect(() => {
    setRepository(searchState.repository || 'proompteng/lab')
    setCommit(searchState.commit)
    setError(null)
    setStatus(null)
  }, [searchState.commit, searchState.repository])

  const submit = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    const normalizedRepository = repository.trim()
    if (!normalizedRepository) {
      setError('Repository is required.')
      repositoryRef.current?.focus()
      return
    }

    setError(null)
    setStatus(null)
    setSubmitting(true)
    try {
      const result = await enrichAtlasRepository({
        repository: normalizedRepository,
        ref: 'main',
        commit: commit.trim() || undefined,
      })
      setStatus(result.ok ? 'Authoritative main reconciliation started.' : result.message)
    } catch (cause) {
      setStatus(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <main className="mx-auto w-full max-w-3xl space-y-4 p-4">
      <header className="space-y-2">
        <h1 className="text-lg font-semibold">Reconcile Atlas</h1>
        <p className="text-xs text-muted-foreground">
          Rebuild the single current corpus from the complete authoritative <code>main</code> tree. Atlas does not
          accept file, branch, or partial-corpus writes.
        </p>
      </header>

      <section className="border bg-card p-4">
        <form className="space-y-3" onSubmit={submit}>
          <div className="grid gap-3 md:grid-cols-2">
            <div className="space-y-1">
              <label className="text-xs font-medium" htmlFor="atlas-reconcile-repository">
                Repository
              </label>
              <Input
                ref={repositoryRef}
                id="atlas-reconcile-repository"
                value={repository}
                onChange={(event) => setRepository(event.target.value)}
                placeholder="proompteng/lab"
                autoComplete="off"
                spellCheck={false}
                aria-invalid={Boolean(error)}
              />
              {error ? (
                <p className="text-xs text-destructive" role="alert">
                  {error}
                </p>
              ) : null}
            </div>
            <div className="space-y-1">
              <label className="text-xs font-medium" htmlFor="atlas-reconcile-commit">
                Observed commit (optional)
              </label>
              <Input
                id="atlas-reconcile-commit"
                value={commit}
                onChange={(event) => setCommit(event.target.value)}
                placeholder="origin/main remains authoritative"
                autoComplete="off"
                spellCheck={false}
              />
            </div>
          </div>

          <Button type="submit" disabled={submitting} aria-busy={submitting}>
            {submitting ? 'Starting…' : 'Reconcile complete main tree'}
          </Button>
          {status ? (
            <p className="text-xs text-muted-foreground" aria-live="polite">
              {status}
            </p>
          ) : null}
        </form>
      </section>
    </main>
  )
}
