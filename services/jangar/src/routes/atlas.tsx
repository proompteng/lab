import { createFileRoute } from '@tanstack/react-router'
import * as React from 'react'

import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import type { AtlasFileItem, AtlasSearchParams } from '@/data/atlas'
import { enrichAtlas, searchAtlas } from '@/data/atlas'

type AtlasSearchState = {
  query: string
  repository: string
  ref: string
  pathPrefix: string
  limit: number
}

const DEFAULT_LIMIT = 25

export const Route = createFileRoute('/atlas')({
  validateSearch: (search: Record<string, unknown>): AtlasSearchState => {
    const limitRaw =
      typeof search.limit === 'number'
        ? search.limit
        : typeof search.limit === 'string'
          ? Number.parseInt(search.limit, 10)
          : DEFAULT_LIMIT
    return {
      query: typeof search.query === 'string' ? search.query : '',
      repository: typeof search.repository === 'string' ? search.repository : '',
      ref: typeof search.ref === 'string' ? search.ref : '',
      pathPrefix: typeof search.pathPrefix === 'string' ? search.pathPrefix : '',
      limit: Number.isFinite(limitRaw) && limitRaw > 0 ? limitRaw : DEFAULT_LIMIT,
    }
  },
  component: AtlasPage,
})

function AtlasPage() {
  const searchState = Route.useSearch()
  const navigate = Route.useNavigate()

  const [query, setQuery] = React.useState(searchState.query)
  const [repository, setRepository] = React.useState(searchState.repository)
  const [ref, setRef] = React.useState(searchState.ref)
  const [pathPrefix, setPathPrefix] = React.useState(searchState.pathPrefix)
  const [limit, setLimit] = React.useState(searchState.limit.toString())

  const [searchResults, setSearchResults] = React.useState<AtlasFileItem[]>([])
  const [searchStatus, setSearchStatus] = React.useState<string | null>(null)
  const [searchError, setSearchError] = React.useState<string | null>(null)
  const [isSearching, setIsSearching] = React.useState(false)

  const [indexedFiles, setIndexedFiles] = React.useState<AtlasFileItem[]>([])
  const [indexedStatus, setIndexedStatus] = React.useState<string | null>(null)
  const [isLoadingIndex, setIsLoadingIndex] = React.useState(false)

  const [selectedFile, setSelectedFile] = React.useState<AtlasFileItem | null>(null)
  const [selectedSource, setSelectedSource] = React.useState<'search' | 'index' | null>(null)

  const [enrichRepository, setEnrichRepository] = React.useState('')
  const [enrichRef, setEnrichRef] = React.useState('')
  const [enrichPath, setEnrichPath] = React.useState('')
  const [enrichCommit, setEnrichCommit] = React.useState('')
  const [enrichContentHash, setEnrichContentHash] = React.useState('')
  const [enrichStatus, setEnrichStatus] = React.useState<string | null>(null)
  const [enrichErrors, setEnrichErrors] = React.useState<{ repository?: string; ref?: string; path?: string }>({})
  const [isEnriching, setIsEnriching] = React.useState(false)

  const queryRef = React.useRef<HTMLInputElement | null>(null)
  const enrichRepositoryRef = React.useRef<HTMLInputElement | null>(null)
  const enrichRefRef = React.useRef<HTMLInputElement | null>(null)
  const enrichPathRef = React.useRef<HTMLInputElement | null>(null)

  React.useEffect(() => {
    setQuery(searchState.query)
    setRepository(searchState.repository)
    setRef(searchState.ref)
    setPathPrefix(searchState.pathPrefix)
    setLimit(searchState.limit.toString())
  }, [searchState.limit, searchState.pathPrefix, searchState.query, searchState.ref, searchState.repository])

  const runSearch = React.useCallback(async (params: AtlasSearchParams) => {
    setIsSearching(true)
    setSearchStatus(null)
    setSearchError(null)
    try {
      const result = await searchAtlas(params)
      if (!result.ok) {
        setSearchResults(result.items ?? [])
        setSearchStatus(result.message)
        return
      }
      setSearchResults(result.items)
      setSearchStatus(result.items.length === 0 ? 'No matches found.' : `Found ${result.items.length} results.`)
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err)
      setSearchStatus(message)
    } finally {
      setIsSearching(false)
    }
  }, [])

  const loadIndexedFiles = React.useCallback(async () => {
    setIsLoadingIndex(true)
    setIndexedStatus(null)
    try {
      const result = await searchAtlas({ query: '', limit: 50 })
      if (!result.ok) {
        setIndexedFiles(result.items ?? [])
        setIndexedStatus(result.message)
        return
      }
      setIndexedFiles(result.items)
      setIndexedStatus(result.items.length === 0 ? 'No indexed files yet.' : `Loaded ${result.items.length} files.`)
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err)
      setIndexedStatus(message)
    } finally {
      setIsLoadingIndex(false)
    }
  }, [])

  React.useEffect(() => {
    void loadIndexedFiles()
  }, [loadIndexedFiles])

  React.useEffect(() => {
    if (!searchState.query.trim()) {
      setSearchResults([])
      setSearchStatus(null)
      return
    }
    void runSearch({
      query: searchState.query.trim(),
      repository: searchState.repository.trim() || undefined,
      ref: searchState.ref.trim() || undefined,
      pathPrefix: searchState.pathPrefix.trim() || undefined,
      limit: searchState.limit,
    })
  }, [runSearch, searchState])

  const submitSearch = (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    const trimmedQuery = query.trim()
    const parsedLimit = Number.parseInt(limit.trim(), 10)
    setSearchError(null)

    if (!trimmedQuery) {
      setSearchError('Query is required.')
      queryRef.current?.focus()
      return
    }

    void navigate({
      search: {
        query: trimmedQuery,
        repository: repository.trim(),
        ref: ref.trim(),
        pathPrefix: pathPrefix.trim(),
        limit: Number.isFinite(parsedLimit) && parsedLimit > 0 ? parsedLimit : DEFAULT_LIMIT,
      },
    })
  }

  const selectFile = (file: AtlasFileItem, source: 'search' | 'index') => {
    setSelectedFile(file)
    setSelectedSource(source)
    setEnrichStatus(null)
    setEnrichErrors({})
    setEnrichRepository(file.repository ?? '')
    setEnrichRef(file.ref ?? '')
    setEnrichPath(file.path ?? '')
    setEnrichCommit(file.commit ?? '')
    setEnrichContentHash(file.contentHash ?? '')
  }

  const submitEnrich = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    setEnrichStatus(null)
    const trimmedRepository = enrichRepository.trim()
    const trimmedRef = enrichRef.trim()
    const trimmedPath = enrichPath.trim()
    const trimmedCommit = enrichCommit.trim()
    const trimmedContentHash = enrichContentHash.trim()

    const nextErrors: { repository?: string; ref?: string; path?: string } = {}
    if (!trimmedRepository) nextErrors.repository = 'Repository is required.'
    if (!trimmedRef) nextErrors.ref = 'Ref is required.'
    if (!trimmedPath) nextErrors.path = 'File path is required.'

    if (Object.keys(nextErrors).length > 0) {
      setEnrichErrors(nextErrors)
      const focusTarget = nextErrors.repository
        ? enrichRepositoryRef.current
        : nextErrors.ref
          ? enrichRefRef.current
          : enrichPathRef.current
      focusTarget?.focus()
      return
    }

    setIsEnriching(true)
    try {
      const result = await enrichAtlas({
        repository: trimmedRepository,
        ref: trimmedRef,
        path: trimmedPath,
        commit: trimmedCommit || undefined,
        contentHash: trimmedContentHash || undefined,
      })
      if (!result.ok) {
        setEnrichStatus(result.message)
        return
      }
      setEnrichStatus(`Enrichment requested (status ${result.status}).`)
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err)
      setEnrichStatus(message)
    } finally {
      setIsEnriching(false)
    }
  }

  return (
    <main className="mx-auto w-full max-w-6xl space-y-6 p-6">
      <header className="space-y-2">
        <p className="text-xs font-medium uppercase tracking-widest text-muted-foreground">Atlas</p>
        <h1 className="text-lg font-semibold">Indexed files</h1>
        <p className="text-xs text-muted-foreground">
          Search indexed files and trigger enrichment for the selected entry.
        </p>
      </header>

      <section className="rounded-none border bg-card p-4">
        <form className="space-y-3" onSubmit={submitSearch}>
          <div className="grid gap-3 md:grid-cols-[2fr,1fr]">
            <div className="space-y-1">
              <label className="text-xs font-medium" htmlFor="atlas-query">
                Query
              </label>
              <Input
                ref={queryRef}
                id="atlas-query"
                name="query"
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                placeholder="Search terms…"
                autoComplete="off"
                aria-invalid={Boolean(searchError)}
              />
              {searchError ? (
                <p className="text-xs text-destructive" role="alert">
                  {searchError}
                </p>
              ) : null}
            </div>
            <div className="space-y-1">
              <label className="text-xs font-medium" htmlFor="atlas-limit">
                Limit
              </label>
              <Input
                id="atlas-limit"
                name="limit"
                type="number"
                inputMode="numeric"
                min={1}
                value={limit}
                onChange={(event) => setLimit(event.target.value)}
                placeholder="25"
                autoComplete="off"
              />
            </div>
          </div>

          <div className="grid gap-3 md:grid-cols-3">
            <div className="space-y-1">
              <label className="text-xs font-medium" htmlFor="atlas-repository">
                Repository
              </label>
              <Input
                id="atlas-repository"
                name="repository"
                value={repository}
                onChange={(event) => setRepository(event.target.value)}
                placeholder="proompteng/lab…"
                autoComplete="off"
                spellCheck={false}
              />
            </div>
            <div className="space-y-1">
              <label className="text-xs font-medium" htmlFor="atlas-ref">
                Ref
              </label>
              <Input
                id="atlas-ref"
                name="ref"
                value={ref}
                onChange={(event) => setRef(event.target.value)}
                placeholder="main…"
                autoComplete="off"
                spellCheck={false}
              />
            </div>
            <div className="space-y-1">
              <label className="text-xs font-medium" htmlFor="atlas-path-prefix">
                Path prefix
              </label>
              <Input
                id="atlas-path-prefix"
                name="pathPrefix"
                value={pathPrefix}
                onChange={(event) => setPathPrefix(event.target.value)}
                placeholder="services/jangar/…"
                autoComplete="off"
                spellCheck={false}
              />
            </div>
          </div>

          <div className="flex flex-wrap items-center gap-2">
            <Button type="submit" disabled={isSearching} aria-busy={isSearching}>
              {isSearching ? (
                <span className="mr-2 size-3 animate-spin rounded-full border border-current border-t-transparent motion-reduce:animate-none" />
              ) : null}
              <span>Search</span>
            </Button>
            <Button
              type="button"
              variant="outline"
              onClick={() => {
                setQuery('')
                setRepository('')
                setRef('')
                setPathPrefix('')
                setLimit(DEFAULT_LIMIT.toString())
                void navigate({ search: { query: '', repository: '', ref: '', pathPrefix: '', limit: DEFAULT_LIMIT } })
              }}
            >
              Clear
            </Button>
          </div>
        </form>

        {searchStatus ? (
          <p aria-live="polite" className="mt-3 text-xs text-muted-foreground">
            {searchStatus}
          </p>
        ) : null}
      </section>

      <section className="space-y-2">
        <SectionHeader title="Search results" subtitle="Matches from the Atlas index" count={searchResults.length} />
        <AtlasResultsTable
          items={searchResults}
          emptyLabel="Run a search to see matches."
          onSelect={(file) => selectFile(file, 'search')}
          selectedFile={selectedFile}
        />
      </section>

      <section className="space-y-2">
        <SectionHeader
          title="Indexed files"
          subtitle="Recent indexed entries (via /api/search)"
          count={indexedFiles.length}
          actions={
            <Button type="button" variant="outline" size="sm" onClick={loadIndexedFiles} disabled={isLoadingIndex}>
              {isLoadingIndex ? (
                <span className="mr-2 size-3 animate-spin rounded-full border border-current border-t-transparent motion-reduce:animate-none" />
              ) : null}
              <span>Refresh</span>
            </Button>
          }
        />
        {indexedStatus ? (
          <p aria-live="polite" className="text-xs text-muted-foreground">
            {indexedStatus}
          </p>
        ) : null}
        <AtlasResultsTable
          items={indexedFiles}
          emptyLabel="No indexed files yet."
          onSelect={(file) => selectFile(file, 'index')}
          selectedFile={selectedFile}
        />
      </section>

      <section className="rounded-none border bg-card p-4">
        <header className="space-y-1">
          <div className="text-xs font-medium uppercase tracking-widest text-muted-foreground">Enrichment</div>
          <h2 className="text-sm font-semibold">Trigger enrichment</h2>
          <p className="text-xs text-muted-foreground">
            {selectedFile
              ? `Selected from ${selectedSource === 'search' ? 'search results' : 'indexed files'}.`
              : 'Select a file to prefill the enrichment form.'}
          </p>
        </header>

        <form className="mt-3 space-y-3" onSubmit={submitEnrich}>
          <div className="grid gap-3 md:grid-cols-3">
            <div className="space-y-1">
              <label className="text-xs font-medium" htmlFor="atlas-enrich-repository">
                Repository
              </label>
              <Input
                ref={enrichRepositoryRef}
                id="atlas-enrich-repository"
                name="repository"
                value={enrichRepository}
                onChange={(event) => setEnrichRepository(event.target.value)}
                placeholder="proompteng/lab…"
                autoComplete="off"
                spellCheck={false}
                aria-invalid={Boolean(enrichErrors.repository)}
              />
              {enrichErrors.repository ? (
                <p className="text-xs text-destructive" role="alert">
                  {enrichErrors.repository}
                </p>
              ) : null}
            </div>
            <div className="space-y-1">
              <label className="text-xs font-medium" htmlFor="atlas-enrich-ref">
                Ref
              </label>
              <Input
                ref={enrichRefRef}
                id="atlas-enrich-ref"
                name="ref"
                value={enrichRef}
                onChange={(event) => setEnrichRef(event.target.value)}
                placeholder="main…"
                autoComplete="off"
                spellCheck={false}
                aria-invalid={Boolean(enrichErrors.ref)}
              />
              {enrichErrors.ref ? (
                <p className="text-xs text-destructive" role="alert">
                  {enrichErrors.ref}
                </p>
              ) : null}
            </div>
            <div className="space-y-1">
              <label className="text-xs font-medium" htmlFor="atlas-enrich-path">
                File path
              </label>
              <Input
                ref={enrichPathRef}
                id="atlas-enrich-path"
                name="path"
                value={enrichPath}
                onChange={(event) => setEnrichPath(event.target.value)}
                placeholder="services/jangar/src/…"
                autoComplete="off"
                spellCheck={false}
                aria-invalid={Boolean(enrichErrors.path)}
              />
              {enrichErrors.path ? (
                <p className="text-xs text-destructive" role="alert">
                  {enrichErrors.path}
                </p>
              ) : null}
            </div>
          </div>

          <div className="grid gap-3 md:grid-cols-2">
            <div className="space-y-1">
              <label className="text-xs font-medium" htmlFor="atlas-enrich-commit">
                Commit (optional)
              </label>
              <Input
                id="atlas-enrich-commit"
                name="commit"
                value={enrichCommit}
                onChange={(event) => setEnrichCommit(event.target.value)}
                placeholder="abcdef123…"
                autoComplete="off"
                spellCheck={false}
              />
            </div>
            <div className="space-y-1">
              <label className="text-xs font-medium" htmlFor="atlas-enrich-content-hash">
                Content hash (optional)
              </label>
              <Input
                id="atlas-enrich-content-hash"
                name="contentHash"
                value={enrichContentHash}
                onChange={(event) => setEnrichContentHash(event.target.value)}
                placeholder="sha256…"
                autoComplete="off"
                spellCheck={false}
              />
            </div>
          </div>

          <div className="flex flex-wrap items-center gap-2">
            <Button type="submit" disabled={isEnriching} aria-busy={isEnriching}>
              {isEnriching ? (
                <span className="mr-2 size-3 animate-spin rounded-full border border-current border-t-transparent motion-reduce:animate-none" />
              ) : null}
              <span>Trigger enrichment</span>
            </Button>
            {selectedFile ? (
              <Button
                type="button"
                variant="outline"
                onClick={() => {
                  setSelectedFile(null)
                  setSelectedSource(null)
                }}
              >
                Clear selection
              </Button>
            ) : null}
          </div>
          {enrichStatus ? (
            <p aria-live="polite" className="text-xs text-muted-foreground">
              {enrichStatus}
            </p>
          ) : null}
        </form>
      </section>
    </main>
  )
}

function SectionHeader({
  title,
  subtitle,
  count,
  actions,
}: {
  title: string
  subtitle: string
  count?: number
  actions?: React.ReactNode
}) {
  return (
    <header className="flex flex-wrap items-center justify-between gap-2">
      <div className="space-y-1">
        <h2 className="text-sm font-semibold">{title}</h2>
        <p className="text-xs text-muted-foreground">{subtitle}</p>
      </div>
      <div className="flex items-center gap-2 text-xs text-muted-foreground">
        {typeof count === 'number' ? <span className="tabular-nums">{count} items</span> : null}
        {actions}
      </div>
    </header>
  )
}

function AtlasResultsTable({
  items,
  emptyLabel,
  onSelect,
  selectedFile,
}: {
  items: AtlasFileItem[]
  emptyLabel: string
  onSelect: (file: AtlasFileItem) => void
  selectedFile: AtlasFileItem | null
}) {
  return (
    <div className="overflow-hidden rounded-none border bg-card">
      <table className="w-full text-xs">
        <thead className="border-b bg-muted/30 text-left uppercase tracking-widest text-muted-foreground">
          <tr>
            <th className="px-3 py-2 font-medium">Repository</th>
            <th className="px-3 py-2 font-medium">Path</th>
            <th className="px-3 py-2 font-medium">Ref</th>
            <th className="px-3 py-2 font-medium text-right">Score</th>
            <th className="px-3 py-2 font-medium text-right">Updated</th>
            <th className="px-3 py-2 font-medium text-right">Action</th>
          </tr>
        </thead>
        <tbody>
          {items.length === 0 ? (
            <tr>
              <td colSpan={6} className="px-3 py-6 text-center text-muted-foreground">
                {emptyLabel}
              </td>
            </tr>
          ) : (
            items.map((item, index) => {
              const key =
                [item.repository, item.path, item.commit, item.ref].filter(Boolean).join(':') || `row-${index}`
              const isSelected =
                selectedFile?.repository === item.repository &&
                selectedFile?.path === item.path &&
                selectedFile?.commit === item.commit &&
                selectedFile?.ref === item.ref
              return (
                <tr
                  key={key}
                  className="border-b last:border-b-0 data-[selected=true]:bg-muted/30"
                  data-selected={isSelected}
                >
                  <td className="px-3 py-2 font-medium text-foreground">{item.repository ?? '—'}</td>
                  <td className="px-3 py-2 text-muted-foreground">{item.path ?? '—'}</td>
                  <td className="px-3 py-2 text-muted-foreground">{item.ref ?? '—'}</td>
                  <td className="px-3 py-2 text-right tabular-nums text-muted-foreground">
                    {typeof item.score === 'number' ? item.score.toFixed(3) : '—'}
                  </td>
                  <td className="px-3 py-2 text-right tabular-nums text-muted-foreground">
                    {item.updatedAt ? formatDate(item.updatedAt) : '—'}
                  </td>
                  <td className="px-3 py-2 text-right">
                    <Button type="button" variant="outline" size="xs" onClick={() => onSelect(item)}>
                      {isSelected ? 'Selected' : 'Select'}
                    </Button>
                  </td>
                </tr>
              )
            })
          )}
        </tbody>
      </table>
    </div>
  )
}

const formatDate = (value: string) => {
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return value
  return new Intl.DateTimeFormat(undefined, {
    year: 'numeric',
    month: 'short',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  }).format(date)
}
