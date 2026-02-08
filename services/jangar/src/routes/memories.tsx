import { Button, Input } from '@proompteng/design/ui'
import { createFileRoute } from '@tanstack/react-router'
import * as React from 'react'

export const Route = createFileRoute('/memories')({
  component: MemoriesPage,
})

function MemoriesPage() {
  const [namespace, setNamespace] = React.useState('default')
  const [query, setQuery] = React.useState('')
  const [isSearching, setIsSearching] = React.useState(false)
  const [error, setError] = React.useState<string | null>(null)
  const [results, setResults] = React.useState<unknown>(null)

  const submitQuery = async () => {
    const trimmedQuery = query.trim()
    setError(null)

    if (!trimmedQuery) {
      setResults(null)
      setError('Query is required.')
      return
    }

    setIsSearching(true)
    try {
      const params = new URLSearchParams({
        namespace: namespace.trim() || 'default',
        query: trimmedQuery,
        limit: '10',
      })
      const response = await fetch(`/api/memories?${params.toString()}`)
      const payload = (await response.json().catch(() => null)) as {
        ok?: boolean
        memories?: unknown[]
        error?: string
        message?: string
      } | null
      if (!response.ok || !payload || payload.ok !== true) {
        const message = payload?.error ?? payload?.message ?? 'Unable to query right now. Please try again.'
        setResults(null)
        setError(message)
        return
      }
      setResults(payload)
    } catch {
      setError('Unable to query right now. Please try again.')
    } finally {
      setIsSearching(false)
    }
  }

  return (
    <main className="mx-auto w-full max-w-4xl p-4">
      <form
        className="flex items-center gap-2"
        onSubmit={(event) => {
          event.preventDefault()
          void submitQuery()
        }}
      >
        <label className="sr-only" htmlFor="memories-namespace">
          Namespace
        </label>
        <Input
          id="memories-namespace"
          name="namespace"
          value={namespace}
          onChange={(event) => setNamespace(event.target.value)}
          placeholder="Namespace"
          autoComplete="off"
          className="w-40"
        />

        <label className="sr-only" htmlFor="memories-query">
          Query
        </label>
        <Input
          id="memories-query"
          name="query"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder="Search…"
          autoComplete="off"
          className="min-w-0 flex-1"
        />

        <Button type="submit" disabled={isSearching}>
          Search
        </Button>
      </form>

      {error ? <div className="mt-3 text-xs text-destructive">{error}</div> : null}
      {results ? (
        <pre className="mt-3 overflow-auto rounded-none border bg-background p-4 text-xs">
          <code className="font-mono tabular-nums">{JSON.stringify(results, null, 2)}</code>
        </pre>
      ) : null}
    </main>
  )
}
