import { createFileRoute } from '@tanstack/react-router'
import * as React from 'react'

import { AtlasResultsTable, AtlasSectionHeader } from '@/components/atlas-results-table'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import type { AtlasFileItem, AtlasSearchParams } from '@/data/atlas'
import { searchAtlas } from '@/data/atlas'

type AtlasSearchState = {
  query: string
  repository: string
  ref: string
  pathPrefix: string
  limit: number
}

const DEFAULT_LIMIT = 25

export const Route = createFileRoute('/atlas/search')({
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
  component: AtlasSearchPage,
})

function AtlasSearchPage() {
  const searchState = Route.useSearch()
  const navigate = Route.useNavigate()

  const [query, setQuery] = React.useState(searchState.query)
  const [repository, setRepository] = React.useState(searchState.repository)
  const [ref, setRef] = React.useState(searchState.ref)
  const [pathPrefix, setPathPrefix] = React.useState(searchState.pathPrefix)
  const [limit, setLimit] = React.useState(searchState.limit.toString())
  const [showAdvanced, setShowAdvanced] = React.useState(
    Boolean(searchState.repository || searchState.ref || searchState.pathPrefix || searchState.limit !== DEFAULT_LIMIT),
  )

  const [searchResults, setSearchResults] = React.useState<AtlasFileItem[]>([])
  const [searchStatus, setSearchStatus] = React.useState<string | null>(null)
  const [searchError, setSearchError] = React.useState<string | null>(null)
  const [isSearching, setIsSearching] = React.useState(false)

  const queryRef = React.useRef<HTMLInputElement | null>(null)
  const advancedId = React.useId()

  React.useEffect(() => {
    setQuery(searchState.query)
    setRepository(searchState.repository)
    setRef(searchState.ref)
    setPathPrefix(searchState.pathPrefix)
    setLimit(searchState.limit.toString())
    if (searchState.repository || searchState.ref || searchState.pathPrefix || searchState.limit !== DEFAULT_LIMIT) {
      setShowAdvanced(true)
    }
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

  const getEnrichAction = React.useCallback(
    (item: AtlasFileItem) => ({
      to: '/atlas/enrich',
      search: buildEnrichSearch(item),
    }),
    [],
  )

  return (
    <main className="mx-auto w-full max-w-6xl space-y-4 p-4">
      <header className="space-y-2">
        <h1 className="text-lg font-semibold">Search</h1>
        <p className="text-xs text-muted-foreground">Search indexed files and jump to enrichment.</p>
      </header>

      <section className="rounded-none border bg-card p-4">
        <form className="space-y-3" onSubmit={submitSearch}>
          <div className="grid gap-3">
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
                setShowAdvanced(false)
                void navigate({ search: { query: '', repository: '', ref: '', pathPrefix: '', limit: DEFAULT_LIMIT } })
              }}
            >
              Clear
            </Button>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              aria-expanded={showAdvanced}
              aria-controls={advancedId}
              onClick={() => setShowAdvanced((current) => !current)}
            >
              {showAdvanced ? 'Hide options' : 'Show options'}
            </Button>
          </div>

          <div id={advancedId} hidden={!showAdvanced} className="grid gap-3 md:grid-cols-[1fr,1fr]">
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
        </form>

        {searchStatus ? (
          <p aria-live="polite" className="mt-3 text-xs text-muted-foreground">
            {searchStatus}
          </p>
        ) : null}
      </section>

      <section className="space-y-2">
        <AtlasSectionHeader title="Results" count={searchResults.length} />
        <AtlasResultsTable
          items={searchResults}
          emptyLabel="Run a search to see matches."
          actionLabel="Enrich"
          getAction={getEnrichAction}
        />
      </section>
    </main>
  )
}

const buildEnrichSearch = (item: AtlasFileItem) => {
  const search: Record<string, string> = {}
  if (item.repository) search.repository = item.repository
  if (item.ref) search.ref = item.ref
  if (item.path) search.path = item.path
  if (item.commit) search.commit = item.commit
  if (item.contentHash) search.contentHash = item.contentHash
  return Object.keys(search).length ? search : undefined
}
