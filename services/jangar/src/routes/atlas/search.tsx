import { createFileRoute, Link } from '@tanstack/react-router'
import * as React from 'react'

import { AtlasSectionHeader } from '@/components/atlas-results-table'
import { Button, buttonVariants } from '@proompteng/design/ui'
import { Input } from '@proompteng/design/ui'
import {
  Pagination,
  PaginationContent,
  PaginationItem,
  PaginationLink,
  PaginationNext,
  PaginationPrevious,
} from '@proompteng/design/ui'
import { ScrollArea } from '@proompteng/design/ui'
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from '@proompteng/design/ui'
import type { AtlasAstPreview, AtlasFileItem, AtlasFilePreview, AtlasSearchParams } from '@/data/atlas'
import { getAtlasAstPreview, getAtlasFilePreview, searchAtlas } from '@/data/atlas'
import { cn } from '@/lib/utils'

type AtlasSearchState = {
  query: string
  repository: string
  pathPrefix: string
  limit: number
  page: number
  panelOpen: boolean
  panelTab: 'content' | 'ast'
  panelPath: string
  panelRepository: string
  panelRef: string
  panelFileVersionId: string
}

const DEFAULT_LIMIT = 25
const MAIN_REF = 'main'
const MAX_PAGE_FETCH_LIMIT = 200

export const Route = createFileRoute('/atlas/search')({
  validateSearch: (search: Record<string, unknown>): AtlasSearchState => {
    const limitRaw =
      typeof search.limit === 'number'
        ? search.limit
        : typeof search.limit === 'string'
          ? Number.parseInt(search.limit, 10)
          : DEFAULT_LIMIT
    const pageRaw =
      typeof search.page === 'number'
        ? search.page
        : typeof search.page === 'string'
          ? Number.parseInt(search.page, 10)
          : 1
    const tabRaw = typeof search.panelTab === 'string' ? search.panelTab : 'content'
    return {
      query: typeof search.query === 'string' ? search.query : '',
      repository: typeof search.repository === 'string' ? search.repository : '',
      pathPrefix: typeof search.pathPrefix === 'string' ? search.pathPrefix : '',
      limit: Number.isFinite(limitRaw) && limitRaw > 0 ? limitRaw : DEFAULT_LIMIT,
      page: Number.isFinite(pageRaw) && pageRaw > 0 ? pageRaw : 1,
      panelOpen: search.panelOpen === '1' || search.panelOpen === 'true' || search.panelOpen === true,
      panelTab: tabRaw === 'ast' ? 'ast' : 'content',
      panelPath: typeof search.panelPath === 'string' ? search.panelPath : '',
      panelRepository: typeof search.panelRepository === 'string' ? search.panelRepository : '',
      panelRef: typeof search.panelRef === 'string' ? search.panelRef : '',
      panelFileVersionId: typeof search.panelFileVersionId === 'string' ? search.panelFileVersionId : '',
    }
  },
  component: AtlasSearchPage,
})

function AtlasSearchPage() {
  const searchState = Route.useSearch()
  const navigate = Route.useNavigate()

  const [query, setQuery] = React.useState(searchState.query)
  const [repository, setRepository] = React.useState(searchState.repository)
  const [pathPrefix, setPathPrefix] = React.useState(searchState.pathPrefix)
  const [limit, setLimit] = React.useState(searchState.limit.toString())
  const [showAdvanced, setShowAdvanced] = React.useState(
    Boolean(searchState.repository || searchState.pathPrefix || searchState.limit !== DEFAULT_LIMIT),
  )

  const [searchResults, setSearchResults] = React.useState<AtlasFileItem[]>([])
  const [searchTotal, setSearchTotal] = React.useState(0)
  const [searchStatus, setSearchStatus] = React.useState<string | null>(null)
  const [searchError, setSearchError] = React.useState<string | null>(null)
  const [isSearching, setIsSearching] = React.useState(false)
  const [selectedItem, setSelectedItem] = React.useState<AtlasFileItem | null>(null)
  const [sheetOpen, setSheetOpen] = React.useState(false)
  const [activeTab, setActiveTab] = React.useState<'content' | 'ast'>('content')
  const [filePreview, setFilePreview] = React.useState<AtlasFilePreview | null>(null)
  const [filePreviewStatus, setFilePreviewStatus] = React.useState<'idle' | 'loading' | 'error'>('idle')
  const [filePreviewError, setFilePreviewError] = React.useState<string | null>(null)
  const [astPreview, setAstPreview] = React.useState<AtlasAstPreview | null>(null)
  const [astStatus, setAstStatus] = React.useState<'idle' | 'loading' | 'error'>('idle')
  const [astError, setAstError] = React.useState<string | null>(null)

  const pageSize = searchState.limit
  const currentPage = searchState.page
  const fetchLimit = Math.min(pageSize * currentPage, MAX_PAGE_FETCH_LIMIT)

  const queryRef = React.useRef<HTMLInputElement | null>(null)
  const advancedId = React.useId()
  const previewCache = React.useRef(new Map<string, AtlasFilePreview>())
  const astCache = React.useRef(new Map<string, AtlasAstPreview>())
  const previewAbortRef = React.useRef<AbortController | null>(null)
  const astAbortRef = React.useRef<AbortController | null>(null)
  const closeRequestedRef = React.useRef(false)

  React.useEffect(() => {
    setQuery(searchState.query)
    setRepository(searchState.repository)
    setPathPrefix(searchState.pathPrefix)
    setLimit(searchState.limit.toString())
    if (searchState.repository || searchState.pathPrefix || searchState.limit !== DEFAULT_LIMIT) {
      setShowAdvanced(true)
    }
  }, [searchState.limit, searchState.pathPrefix, searchState.query, searchState.repository])

  const runSearch = React.useCallback(async (params: AtlasSearchParams) => {
    setIsSearching(true)
    setSearchStatus(null)
    setSearchError(null)
    try {
      const result = await searchAtlas(params)
      const total = Number.isFinite(result.total)
        ? Math.max(result.items.length, result.total ?? 0)
        : result.items.length
      if (!result.ok) {
        setSearchResults(result.items ?? [])
        setSearchTotal(total)
        setSearchStatus(result.message)
        return
      }
      setSearchResults(result.items)
      setSearchTotal(total)
      setSearchStatus(result.items.length === 0 ? 'No matches found.' : `Found ${total} matches.`)
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err)
      setSearchTotal(0)
      setSearchStatus(message)
    } finally {
      setIsSearching(false)
    }
  }, [])

  React.useEffect(() => {
    const trimmedQuery = searchState.query.trim()
    const trimmedRepository = searchState.repository.trim()
    const trimmedPathPrefix = searchState.pathPrefix.trim()
    if (!trimmedQuery) {
      setSearchResults([])
      setSearchTotal(0)
      setSearchStatus(null)
      return
    }
    void runSearch({
      query: trimmedQuery,
      repository: trimmedRepository || undefined,
      pathPrefix: trimmedPathPrefix || undefined,
      ref: MAIN_REF,
      limit: fetchLimit,
    })
  }, [fetchLimit, runSearch, searchState.pathPrefix, searchState.query, searchState.repository])

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
        pathPrefix: pathPrefix.trim(),
        limit: Number.isFinite(parsedLimit) && parsedLimit > 0 ? parsedLimit : DEFAULT_LIMIT,
        page: 1,
        panelOpen: false,
        panelTab: 'content',
        panelPath: '',
        panelRepository: '',
        panelRef: '',
        panelFileVersionId: '',
      },
    })
  }

  const updatePanelSearch = React.useCallback(
    (next: { open: boolean; tab: 'content' | 'ast'; item?: AtlasFileItem | null }) => {
      const nextItem = next.item
      void navigate({
        replace: true,
        search: {
          query: searchState.query,
          repository: searchState.repository,
          pathPrefix: searchState.pathPrefix,
          limit: searchState.limit,
          page: searchState.page,
          panelOpen: next.open,
          panelTab: next.tab,
          panelPath: next.open && nextItem?.path ? nextItem.path : '',
          panelRepository: next.open && nextItem?.repository ? nextItem.repository : '',
          panelRef: next.open && nextItem?.ref ? nextItem.ref : '',
          panelFileVersionId: next.open && nextItem?.fileVersionId ? nextItem.fileVersionId : '',
        },
      })
    },
    [navigate, searchState],
  )

  const resetPreviewState = React.useCallback(() => {
    previewAbortRef.current?.abort()
    astAbortRef.current?.abort()
    setSelectedItem(null)
    setFilePreview(null)
    setAstPreview(null)
    setFilePreviewStatus('idle')
    setAstStatus('idle')
    setFilePreviewError(null)
    setAstError(null)
    setSheetOpen(false)
  }, [])

  const openPreview = React.useCallback(
    (item: AtlasFileItem) => {
      closeRequestedRef.current = false
      setSelectedItem(item)
      setSheetOpen(true)
      setActiveTab('content')
      updatePanelSearch({ open: true, tab: 'content', item })
    },
    [updatePanelSearch],
  )

  const closePreview = React.useCallback(() => {
    closeRequestedRef.current = true
    resetPreviewState()
    updatePanelSearch({ open: false, tab: 'content' })
  }, [resetPreviewState, updatePanelSearch])

  const loadFilePreview = React.useCallback(async (item: AtlasFileItem) => {
    if (!item.path) {
      setFilePreview(null)
      setFilePreviewStatus('error')
      setFilePreviewError('File path missing for this result.')
      return
    }

    const key = [item.repository, item.ref ?? MAIN_REF, item.path].filter(Boolean).join(':')
    const cached = previewCache.current.get(key)
    if (cached) {
      setFilePreview(cached)
      setFilePreviewStatus(cached.ok ? 'idle' : 'error')
      setFilePreviewError(cached.ok ? null : cached.message)
      return
    }

    previewAbortRef.current?.abort()
    const controller = new AbortController()
    previewAbortRef.current = controller

    setFilePreview(null)
    setFilePreviewStatus('loading')
    setFilePreviewError(null)

    try {
      const result = await getAtlasFilePreview({
        repository: item.repository ?? undefined,
        ref: item.ref ?? MAIN_REF,
        path: item.path,
        signal: controller.signal,
      })
      if (controller.signal.aborted) return
      if (result.ok) {
        previewCache.current.set(key, result)
      }
      setFilePreview(result)
      setFilePreviewStatus(result.ok ? 'idle' : 'error')
      setFilePreviewError(result.ok ? null : result.message)
    } catch (err: unknown) {
      if (controller.signal.aborted) return
      const message = err instanceof Error ? err.message : String(err)
      setFilePreviewStatus('error')
      setFilePreviewError(message)
    }
  }, [])

  const loadAstPreview = React.useCallback(async (item: AtlasFileItem) => {
    if (!item.fileVersionId) {
      setAstPreview({ ok: true, facts: [], summary: undefined })
      setAstStatus('idle')
      setAstError(null)
      return
    }

    const cached = astCache.current.get(item.fileVersionId)
    if (cached) {
      setAstPreview(cached)
      setAstStatus(cached.ok ? 'idle' : 'error')
      setAstError(cached.ok ? null : cached.message)
      return
    }

    astAbortRef.current?.abort()
    const controller = new AbortController()
    astAbortRef.current = controller

    setAstPreview(null)
    setAstStatus('loading')
    setAstError(null)

    try {
      const result = await getAtlasAstPreview({
        fileVersionId: item.fileVersionId,
        limit: 400,
        signal: controller.signal,
      })
      if (controller.signal.aborted) return
      if (result.ok) {
        astCache.current.set(item.fileVersionId, result)
      }
      setAstPreview(result)
      setAstStatus(result.ok ? 'idle' : 'error')
      setAstError(result.ok ? null : result.message)
    } catch (err: unknown) {
      if (controller.signal.aborted) return
      const message = err instanceof Error ? err.message : String(err)
      setAstStatus('error')
      setAstError(message)
    }
  }, [])

  React.useEffect(() => {
    if (!sheetOpen || !selectedItem) return
    void loadFilePreview(selectedItem)
    void loadAstPreview(selectedItem)
  }, [loadAstPreview, loadFilePreview, selectedItem, sheetOpen])

  React.useEffect(() => {
    if (!searchState.panelOpen) {
      closeRequestedRef.current = false
      if (sheetOpen || selectedItem) {
        resetPreviewState()
      }
      return
    }
    if (closeRequestedRef.current) return
    setSheetOpen(true)
    setActiveTab(searchState.panelTab)

    const panelPath = searchState.panelPath.trim()
    const panelFileVersionId = searchState.panelFileVersionId.trim()
    if (!panelPath && !panelFileVersionId) {
      closePreview()
      return
    }

    const panelRepo = searchState.panelRepository.trim()
    const panelRef = searchState.panelRef.trim() || MAIN_REF
    const match = searchResults.find((item) => {
      if (!item.path) return false
      if (panelFileVersionId && item.fileVersionId === panelFileVersionId) return true
      const samePath = item.path === panelPath
      const sameRepo = panelRepo ? item.repository === panelRepo : true
      const sameRef = panelRef ? (item.ref ?? MAIN_REF) === panelRef : true
      return samePath && sameRepo && sameRef
    })

    const fallbackItem: AtlasFileItem = {
      path: panelPath,
      repository: panelRepo || undefined,
      ref: panelRef,
      fileVersionId: panelFileVersionId || undefined,
    }
    const nextItem = match ?? fallbackItem
    const isSameSelection =
      selectedItem?.path === nextItem.path &&
      (selectedItem?.repository ?? '') === (nextItem.repository ?? '') &&
      (selectedItem?.ref ?? '') === (nextItem.ref ?? '') &&
      (selectedItem?.fileVersionId ?? '') === (nextItem.fileVersionId ?? '')
    if (!isSameSelection) {
      setSelectedItem(nextItem)
    }
  }, [
    closePreview,
    resetPreviewState,
    searchResults,
    searchState.panelFileVersionId,
    searchState.panelOpen,
    searchState.panelPath,
    searchState.panelRef,
    searchState.panelRepository,
    searchState.panelTab,
    sheetOpen,
    selectedItem,
  ])

  const totalResults = searchTotal
  const cappedTotal = Math.min(totalResults, MAX_PAGE_FETCH_LIMIT)
  const totalPages = Math.max(1, Math.ceil(cappedTotal / pageSize))
  const clampedPage = Math.min(currentPage, totalPages)
  const isFirstPage = clampedPage <= 1
  const isLastPage = clampedPage >= totalPages
  const pageStartIndex = (clampedPage - 1) * pageSize
  const pageResults = searchResults.slice(pageStartIndex, pageStartIndex + pageSize)
  const rangeStart = totalResults > 0 ? pageStartIndex + 1 : 0
  const rangeEnd = totalResults > 0 ? Math.min(pageStartIndex + pageResults.length, totalResults) : 0
  const pageNumbers = React.useMemo(() => {
    if (totalPages <= 1) return [1]
    const windowSize = 5
    const start = Math.max(1, Math.min(clampedPage - 2, totalPages - windowSize + 1))
    const count = Math.min(totalPages, windowSize)
    return Array.from({ length: count }, (_, index) => start + index)
  }, [clampedPage, totalPages])
  const isCapped = totalResults > MAX_PAGE_FETCH_LIMIT
  const totalLabel = `${totalResults}`
  const rangeLabel = totalResults === 0 ? 'No results yet.' : `${rangeStart}-${rangeEnd} of ${totalLabel}`
  const pageLabel = totalPages > 1 ? `Page ${clampedPage}/${totalPages}` : 'Page 1'
  const capLabel = isCapped ? `Capped at ${MAX_PAGE_FETCH_LIMIT}` : null

  const goToPage = React.useCallback(
    (page: number) => {
      void navigate({
        search: {
          query: searchState.query,
          repository: searchState.repository,
          pathPrefix: searchState.pathPrefix,
          limit: searchState.limit,
          page,
          panelOpen: searchState.panelOpen,
          panelTab: searchState.panelTab,
          panelPath: searchState.panelPath,
          panelRepository: searchState.panelRepository,
          panelRef: searchState.panelRef,
          panelFileVersionId: searchState.panelFileVersionId,
        },
      })
    },
    [
      navigate,
      searchState.limit,
      searchState.panelFileVersionId,
      searchState.panelOpen,
      searchState.panelPath,
      searchState.panelRef,
      searchState.panelRepository,
      searchState.panelTab,
      searchState.pathPrefix,
      searchState.query,
      searchState.repository,
    ],
  )

  React.useEffect(() => {
    if (currentPage !== clampedPage) {
      goToPage(clampedPage)
    }
  }, [clampedPage, currentPage, goToPage])

  return (
    <main className="mx-auto flex h-full min-h-0 w-full max-w-6xl flex-col gap-4 p-4">
      <header className="space-y-2">
        <h1 className="text-lg font-semibold">Search</h1>
        <p className="text-xs text-muted-foreground">Search indexed files on main and open previews.</p>
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
                setPathPrefix('')
                setLimit(DEFAULT_LIMIT.toString())
                setShowAdvanced(false)
                void navigate({
                  search: {
                    query: '',
                    repository: '',
                    pathPrefix: '',
                    limit: DEFAULT_LIMIT,
                    page: 1,
                    panelOpen: false,
                    panelTab: 'content',
                    panelPath: '',
                    panelRepository: '',
                    panelRef: '',
                    panelFileVersionId: '',
                  },
                })
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

      <section className="flex min-h-0 flex-1 flex-col gap-2">
        <AtlasSectionHeader
          title="Results"
          actions={
            <div className="flex flex-wrap items-center text-[11px] text-muted-foreground">
              <span className="tabular-nums pr-2">{rangeLabel}</span>
              <span className="tabular-nums border-l border-border/60 px-2">{pageLabel}</span>
              {capLabel ? <span className="hidden border-l border-border/60 pl-2 sm:inline">{capLabel}</span> : null}
            </div>
          }
        />
        <div className="flex min-h-0 flex-1 flex-col overflow-hidden rounded-none border bg-card">
          {totalResults === 0 ? (
            <div className="p-6 text-center text-xs text-muted-foreground">Run a search to see matches.</div>
          ) : (
            <ScrollArea className="min-h-0 flex-1">
              <div className="divide-y">
                {pageResults.map((item, index) => {
                  const key =
                    [item.fileVersionId, item.repository, item.path, item.ref, item.commit].filter(Boolean).join(':') ||
                    `row-${index}`
                  let scoreLabel = '—'
                  if (typeof item.score === 'number') {
                    scoreLabel = item.score.toFixed(3)
                  }
                  const updatedLabel = item.updatedAt ? formatDate(item.updatedAt) : '—'
                  return (
                    <button
                      key={key}
                      type="button"
                      onClick={() => openPreview(item)}
                      className="w-full text-left transition hover:bg-muted/40"
                    >
                      <div className="flex flex-col gap-2 p-4">
                        <div className="flex flex-wrap items-center justify-between gap-2">
                          <div className="flex flex-col">
                            <span className="text-sm font-semibold text-foreground">{item.path ?? 'Unknown path'}</span>
                            <span className="text-[11px] text-muted-foreground">
                              {item.repository ?? '—'} · {item.ref ?? MAIN_REF}
                            </span>
                          </div>
                          <div className="flex items-center gap-3 text-[11px] text-muted-foreground">
                            <span className="tabular-nums">Score {scoreLabel}</span>
                            <span className="tabular-nums">{updatedLabel}</span>
                          </div>
                        </div>
                        <p className="text-xs text-muted-foreground">
                          {item.summary?.trim() ? item.summary : 'No summary available yet for this file.'}
                        </p>
                        {item.tags && item.tags.length > 0 ? (
                          <div className="flex flex-wrap items-center gap-2">
                            {item.tags.slice(0, 8).map((tag) => (
                              <span
                                key={tag}
                                className="rounded-none border border-border bg-muted/30 px-2 py-0.5 text-[10px] uppercase tracking-wide text-muted-foreground"
                              >
                                {tag}
                              </span>
                            ))}
                          </div>
                        ) : null}
                      </div>
                    </button>
                  )
                })}
              </div>
            </ScrollArea>
          )}
          {totalResults > 0 ? (
            <div className="border-t px-3 py-2">
              <Pagination>
                <PaginationContent>
                  <PaginationItem>
                    <PaginationPrevious
                      aria-disabled={isFirstPage}
                      className={isFirstPage ? 'pointer-events-none opacity-50' : undefined}
                      onClick={() => {
                        if (isFirstPage) return
                        goToPage(Math.max(1, clampedPage - 1))
                      }}
                    />
                  </PaginationItem>
                </PaginationContent>
                <PaginationContent>
                  {pageNumbers.map((page) => (
                    <PaginationItem key={page}>
                      <PaginationLink isActive={page === clampedPage} onClick={() => goToPage(page)}>
                        {page}
                      </PaginationLink>
                    </PaginationItem>
                  ))}
                </PaginationContent>
                <PaginationContent>
                  <PaginationItem>
                    <PaginationNext
                      aria-disabled={isLastPage}
                      className={isLastPage ? 'pointer-events-none opacity-50' : undefined}
                      onClick={() => {
                        if (isLastPage) return
                        goToPage(Math.min(totalPages, clampedPage + 1))
                      }}
                    />
                  </PaginationItem>
                </PaginationContent>
              </Pagination>
            </div>
          ) : null}
        </div>
      </section>

      <Sheet
        open={sheetOpen}
        onOpenChange={(open) => {
          if (open) {
            closeRequestedRef.current = false
            if (selectedItem) {
              updatePanelSearch({ open: true, tab: activeTab, item: selectedItem })
            }
            setSheetOpen(true)
            return
          }
          closePreview()
        }}
      >
        <SheetContent
          side="right"
          className="min-h-0 flex flex-col data-[side=right]:w-[min(96vw,120rem)] data-[side=right]:sm:w-[min(92vw,120rem)] data-[side=right]:sm:max-w-none"
        >
          <SheetHeader className="gap-2 border-b px-4 py-3 pr-12">
            <SheetTitle className="break-words text-base">{selectedItem?.path ?? 'File preview'}</SheetTitle>
            <SheetDescription>
              {selectedItem?.repository ?? '—'} · {selectedItem?.ref ?? MAIN_REF}
            </SheetDescription>
            {selectedItem ? (
              <div className="flex flex-wrap items-center gap-2 pt-2">
                <Link
                  to="/atlas/enrich"
                  search={buildEnrichSearch(selectedItem)}
                  className={cn(buttonVariants({ variant: 'default', size: 'sm' }))}
                >
                  Enrich
                </Link>
                <span className="text-[11px] text-muted-foreground">
                  Score {typeof selectedItem.score === 'number' ? selectedItem.score.toFixed(3) : '—'}
                </span>
                <span className="text-[11px] text-muted-foreground">
                  Updated {selectedItem.updatedAt ? formatDate(selectedItem.updatedAt) : '—'}
                </span>
              </div>
            ) : null}
          </SheetHeader>

          <div className="flex items-center gap-2 border-b px-4 py-2">
            <Button
              type="button"
              size="sm"
              variant={activeTab === 'content' ? 'secondary' : 'ghost'}
              onClick={() => {
                setActiveTab('content')
                updatePanelSearch({ open: true, tab: 'content', item: selectedItem ?? undefined })
              }}
            >
              Content
            </Button>
            <Button
              type="button"
              size="sm"
              variant={activeTab === 'ast' ? 'secondary' : 'ghost'}
              onClick={() => {
                setActiveTab('ast')
                updatePanelSearch({ open: true, tab: 'ast', item: selectedItem ?? undefined })
              }}
            >
              AST
            </Button>
          </div>

          <div className="min-h-0 flex-1">
            <ScrollArea className="h-full">
              <div className="p-4">
                {activeTab === 'content' ? (
                  <div className="space-y-3">
                    {filePreviewStatus === 'loading' ? (
                      <div className="flex items-center gap-2 text-xs text-muted-foreground">
                        <span className="size-3 animate-spin rounded-full border border-current border-t-transparent motion-reduce:animate-none" />
                        Loading file preview…
                      </div>
                    ) : filePreviewStatus === 'error' ? (
                      <p className="text-xs text-destructive">{filePreviewError ?? 'Failed to load file preview.'}</p>
                    ) : filePreview?.ok ? (
                      <div className="space-y-2">
                        {filePreview.truncated ? (
                          <p className="text-[11px] text-muted-foreground">
                            Showing the first {filePreview.content.split('\n').length} lines (truncated for
                            performance).
                          </p>
                        ) : null}
                        <pre className="overflow-auto rounded-none border p-3 font-mono text-[11px] text-foreground bg-muted/20">
                          {filePreview.content || 'File preview is empty.'}
                        </pre>
                      </div>
                    ) : (
                      <p className="text-xs text-muted-foreground">Select a file to preview its content.</p>
                    )}
                  </div>
                ) : (
                  <div className="space-y-3">
                    {astStatus === 'loading' ? (
                      <div className="flex items-center gap-2 text-xs text-muted-foreground">
                        <span className="size-3 animate-spin rounded-full border border-current border-t-transparent motion-reduce:animate-none" />
                        Loading AST facts…
                      </div>
                    ) : astStatus === 'error' ? (
                      <p className="text-xs text-destructive">{astError ?? 'Failed to load AST facts.'}</p>
                    ) : astPreview?.ok ? (
                      <div className="space-y-4">
                        {astPreview.summary ? (
                          <pre className="whitespace-pre-wrap rounded-none border p-3 font-mono text-[11px] text-foreground bg-muted/20">
                            {astPreview.summary}
                          </pre>
                        ) : null}
                        {astPreview.facts.length > 0 ? (
                          <div className="space-y-2">
                            <p className="text-[11px] uppercase tracking-wide text-muted-foreground">AST facts</p>
                            <div className="overflow-auto rounded-none border bg-background">
                              <table className="w-full text-[11px]">
                                <thead className="border-b bg-muted/30 text-left uppercase tracking-widest text-muted-foreground">
                                  <tr>
                                    <th className="px-3 py-2 font-medium">Lines</th>
                                    <th className="px-3 py-2 font-medium">Node</th>
                                    <th className="px-3 py-2 font-medium">Snippet</th>
                                  </tr>
                                </thead>
                                <tbody>
                                  {astPreview.facts.map((fact, factIndex) => (
                                    <tr key={`${fact.nodeType}-${factIndex}`} className="border-b last:border-b-0">
                                      <td className="px-3 py-2 text-muted-foreground">
                                        {fact.startLine ?? '—'}-{fact.endLine ?? '—'}
                                      </td>
                                      <td className="px-3 py-2 font-medium text-foreground">{fact.nodeType}</td>
                                      <td className="px-3 py-2 font-mono text-foreground">{fact.matchText}</td>
                                    </tr>
                                  ))}
                                </tbody>
                              </table>
                            </div>
                          </div>
                        ) : (
                          <p className="text-xs text-muted-foreground">No AST facts stored for this file yet.</p>
                        )}
                      </div>
                    ) : (
                      <p className="text-xs text-muted-foreground">Select a file to inspect its AST.</p>
                    )}
                  </div>
                )}
              </div>
            </ScrollArea>
          </div>
        </SheetContent>
      </Sheet>
    </main>
  )
}

const buildEnrichSearch = (item: AtlasFileItem) => {
  return {
    repository: item.repository ?? '',
    ref: item.ref ?? MAIN_REF,
    path: item.path ?? '',
    commit: item.commit ?? '',
    contentHash: item.contentHash ?? '',
  }
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
