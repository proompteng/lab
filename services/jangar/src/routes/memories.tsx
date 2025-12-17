import { createFileRoute, Link } from '@tanstack/react-router'
import React from 'react'

import { serverFns } from '../data/memories'

export const Route = createFileRoute('/memories')({
  component: MemoriesPage,
})

const parseTags = (raw: string): string[] =>
  raw
    .split(/[,\\n]/)
    .map((tag) => tag.trim())
    .filter((tag) => tag.length > 0)

function MemoriesPage() {
  const [namespace, setNamespace] = React.useState('default')

  const [noteContent, setNoteContent] = React.useState('')
  const [noteSummary, setNoteSummary] = React.useState('')
  const [noteTags, setNoteTags] = React.useState('')
  const [saveError, setSaveError] = React.useState<string | null>(null)
  const [saveStatus, setSaveStatus] = React.useState<string | null>(null)
  const [isSaving, setIsSaving] = React.useState(false)

  const [query, setQuery] = React.useState('')
  const [limit, setLimit] = React.useState(10)
  const [searchError, setSearchError] = React.useState<string | null>(null)
  const [isSearching, setIsSearching] = React.useState(false)
  const [results, setResults] = React.useState<
    Array<{
      id: string
      namespace: string
      summary: string | null
      tags: string[]
      createdAt: string
      distance?: number
      content: string
    }>
  >([])

  const contentRef = React.useRef<HTMLTextAreaElement | null>(null)
  const queryRef = React.useRef<HTMLTextAreaElement | null>(null)

  const submitNote = async () => {
    setSaveStatus(null)
    setSaveError(null)

    const trimmedContent = noteContent.trim()
    if (!trimmedContent) {
      setSaveError('Content is required.')
      contentRef.current?.focus()
      return
    }

    setIsSaving(true)
    try {
      const result = await serverFns.persistNote({
        data: {
          namespace,
          content: trimmedContent,
          summary: noteSummary.trim().length > 0 ? noteSummary.trim() : undefined,
          tags: parseTags(noteTags),
        },
      })
      if (!result.ok) {
        setSaveError(result.message)
        return
      }

      setSaveStatus(`Saved memory ${result.memory.id}`)
      setNoteContent('')
      setNoteSummary('')
      setNoteTags('')
    } catch {
      setSaveError('Unable to save right now. Please try again.')
    } finally {
      setIsSaving(false)
    }
  }

  const submitQuery = async () => {
    setSearchError(null)

    const trimmedQuery = query.trim()
    if (!trimmedQuery) {
      setSearchError('Query is required.')
      queryRef.current?.focus()
      return
    }

    setIsSearching(true)
    try {
      const result = await serverFns.retrieveNotes({
        data: { namespace, query: trimmedQuery, limit },
      })
      if (!result.ok) {
        setSearchError(result.message)
        return
      }
      setResults(result.memories)
    } catch {
      setSearchError('Unable to query right now. Please try again.')
    } finally {
      setIsSearching(false)
    }
  }

  return (
    <main className="mx-auto max-w-5xl px-6 py-12 space-y-10">
      <header className="space-y-2">
        <p className="text-sm uppercase tracking-widest text-cyan-400">Jangar</p>
        <h1 className="text-3xl font-semibold">Memories</h1>
        <p className="text-slate-300 max-w-3xl">
          Save notes and retrieve them with semantic search (natural language queries).
        </p>
        <div className="text-sm text-slate-400">
          <Link className="text-cyan-300 underline" to="/">
            Home
          </Link>
        </div>
      </header>

      <section className="rounded-xl border border-slate-800 bg-slate-900 p-5 shadow-lg shadow-black/30 space-y-4">
        <div className="flex flex-col gap-1">
          <h2 className="text-lg font-medium">Namespace</h2>
          <p className="text-sm text-slate-400">
            Used to keep unrelated memories separate. Both forms below use the same namespace.
          </p>
        </div>

        <div className="grid gap-2 max-w-xl">
          <label className="text-sm text-slate-300" htmlFor="memories-namespace">
            Namespace
          </label>
          <input
            id="memories-namespace"
            name="namespace"
            className="rounded-md border border-slate-700 bg-slate-950 px-3 py-2 text-slate-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-cyan-400"
            value={namespace}
            onChange={(event) => setNamespace(event.target.value)}
            autoComplete="off"
            inputMode="text"
          />
        </div>
      </section>

      <section className="grid gap-6 lg:grid-cols-2">
        <div className="rounded-xl border border-slate-800 bg-slate-900 p-5 shadow-lg shadow-black/30 space-y-4">
          <div className="space-y-1">
            <h2 className="text-lg font-medium">Save note</h2>
            <p className="text-sm text-slate-400">Creates a new memory record.</p>
          </div>

          <div className="grid gap-3">
            <div className="grid gap-2">
              <label className="text-sm text-slate-300" htmlFor="memories-content">
                Content
              </label>
              <textarea
                id="memories-content"
                name="content"
                ref={contentRef}
                className="min-h-40 rounded-md border border-slate-700 bg-slate-950 px-3 py-2 text-slate-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-cyan-400"
                value={noteContent}
                onChange={(event) => setNoteContent(event.target.value)}
                onKeyDown={(event) => {
                  if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') {
                    event.preventDefault()
                    submitNote()
                  }
                }}
                placeholder="Write a note…"
              />
              <p className="text-xs text-slate-500">Tip: Press Ctrl/Cmd+Enter to save.</p>
            </div>

            <div className="grid gap-2">
              <label className="text-sm text-slate-300" htmlFor="memories-summary">
                Summary (optional)
              </label>
              <input
                id="memories-summary"
                name="summary"
                className="rounded-md border border-slate-700 bg-slate-950 px-3 py-2 text-slate-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-cyan-400"
                value={noteSummary}
                onChange={(event) => setNoteSummary(event.target.value)}
                autoComplete="off"
              />
            </div>

            <div className="grid gap-2">
              <label className="text-sm text-slate-300" htmlFor="memories-tags">
                Tags (optional)
              </label>
              <input
                id="memories-tags"
                name="tags"
                className="rounded-md border border-slate-700 bg-slate-950 px-3 py-2 text-slate-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-cyan-400"
                value={noteTags}
                onChange={(event) => setNoteTags(event.target.value)}
                autoComplete="off"
                placeholder="e.g. pr-1983, infra, notes"
              />
            </div>

            {saveError ? (
              <div className="rounded-md border border-red-900/60 bg-red-950/40 px-3 py-2 text-sm text-red-200">
                {saveError}
              </div>
            ) : null}

            <div aria-live="polite" className="text-sm text-slate-300">
              {saveStatus ? saveStatus : null}
            </div>

            <button
              type="button"
              className="inline-flex items-center justify-center rounded-md bg-cyan-500 px-4 py-2 text-sm font-medium text-slate-950 hover:bg-cyan-400 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-cyan-400 disabled:opacity-60 disabled:hover:bg-cyan-500"
              onClick={() => submitNote()}
              disabled={isSaving}
            >
              {isSaving ? 'Saving…' : 'Save note'}
            </button>
          </div>
        </div>

        <div className="rounded-xl border border-slate-800 bg-slate-900 p-5 shadow-lg shadow-black/30 space-y-4">
          <div className="space-y-1">
            <h2 className="text-lg font-medium">Search</h2>
            <p className="text-sm text-slate-400">Ask in natural language and get relevant memories back.</p>
          </div>

          <div className="grid gap-3">
            <div className="grid gap-2">
              <label className="text-sm text-slate-300" htmlFor="memories-query">
                Query
              </label>
              <textarea
                id="memories-query"
                name="query"
                ref={queryRef}
                className="min-h-28 rounded-md border border-slate-700 bg-slate-950 px-3 py-2 text-slate-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-cyan-400"
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                onKeyDown={(event) => {
                  if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') {
                    event.preventDefault()
                    submitQuery()
                  }
                }}
                placeholder='e.g. "what did we change for PR 1983?"'
              />
              <p className="text-xs text-slate-500">Tip: Press Ctrl/Cmd+Enter to search.</p>
            </div>

            <div className="grid gap-2 max-w-xs">
              <label className="text-sm text-slate-300" htmlFor="memories-limit">
                Limit
              </label>
              <input
                id="memories-limit"
                name="limit"
                type="number"
                inputMode="numeric"
                className="rounded-md border border-slate-700 bg-slate-950 px-3 py-2 text-slate-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-cyan-400"
                value={String(limit)}
                onChange={(event) => setLimit(Math.max(1, Math.min(50, Number(event.target.value) || 10)))}
                min={1}
                max={50}
              />
            </div>

            {searchError ? (
              <div className="rounded-md border border-red-900/60 bg-red-950/40 px-3 py-2 text-sm text-red-200">
                {searchError}
              </div>
            ) : null}

            <button
              type="button"
              className="inline-flex items-center justify-center rounded-md bg-slate-100 px-4 py-2 text-sm font-medium text-slate-950 hover:bg-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-cyan-400 disabled:opacity-60"
              onClick={() => submitQuery()}
              disabled={isSearching}
            >
              {isSearching ? 'Searching…' : 'Search'}
            </button>
          </div>
        </div>
      </section>

      <section className="space-y-3">
        <div className="flex items-baseline justify-between gap-3">
          <h2 className="text-lg font-medium">Results</h2>
          <p className="text-sm text-slate-400 tabular-nums">
            {results.length} result{results.length === 1 ? '' : 's'}
          </p>
        </div>

        {results.length === 0 ? (
          <div className="rounded-xl border border-slate-800 bg-slate-900 p-5 text-sm text-slate-400">
            Run a search to see results here.
          </div>
        ) : (
          <div className="grid gap-3">
            {results.map((memory) => (
              <details
                key={memory.id}
                className="rounded-xl border border-slate-800 bg-slate-900 p-4 shadow-lg shadow-black/30"
              >
                <summary className="cursor-pointer list-none focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-cyan-400 rounded">
                  <div className="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
                    <div className="space-y-1">
                      <p className="text-sm text-slate-300">
                        <span className="text-slate-400">Summary:</span> {memory.summary ?? '—'}
                      </p>
                      <div className="flex flex-wrap gap-2 text-xs text-slate-400">
                        <span className="rounded bg-slate-800 px-2 py-0.5">id: {memory.id}</span>
                        <span className="rounded bg-slate-800 px-2 py-0.5">created: {memory.createdAt}</span>
                        {typeof memory.distance === 'number' ? (
                          <span className="rounded bg-slate-800 px-2 py-0.5">
                            distance: {memory.distance.toFixed(4)}
                          </span>
                        ) : null}
                      </div>
                      {memory.tags.length > 0 ? (
                        <div className="flex flex-wrap gap-2">
                          {memory.tags.map((tag) => (
                            <span key={tag} className="rounded bg-slate-800 px-2 py-0.5 text-xs text-slate-300">
                              {tag}
                            </span>
                          ))}
                        </div>
                      ) : null}
                    </div>
                    <span className="text-xs text-cyan-300 underline">View content</span>
                  </div>
                </summary>
                <div className="mt-3 rounded-md border border-slate-800 bg-slate-950 p-3 text-sm text-slate-200 whitespace-pre-wrap">
                  {memory.content}
                </div>
              </details>
            ))}
          </div>
        )}
      </section>
    </main>
  )
}
