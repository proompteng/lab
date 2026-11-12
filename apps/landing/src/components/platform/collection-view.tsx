'use client'

import { Button, Input } from '@proompteng/design/ui'
import { useSyncExternalStore } from 'react'
import { SettingsSelect } from './settings-select'

const subscribe = (notify: () => void) => {
  window.addEventListener('popstate', notify)
  return () => window.removeEventListener('popstate', notify)
}
// Native history is supported by Next and by the real browser fixture. URL state is the single source of truth.
export function usePortalQuery() {
  const search = useSyncExternalStore(
    subscribe,
    () => window.location.search,
    () => '',
  )
  const query = new URLSearchParams(search)
  const change = (values: Record<string, string>) => {
    const url = new URL(window.location.href)
    for (const [key, value] of Object.entries(values)) {
      if (value) url.searchParams.set(key, value)
      else url.searchParams.delete(key)
    }
    window.history.pushState(null, '', url)
    window.dispatchEvent(new PopStateEvent('popstate'))
  }
  return { query, change }
}

export function useCollection<T>(
  items: T[],
  text: (item: T) => string,
  matches: (item: T, filter: string) => boolean = () => true,
) {
  const { query, change } = usePortalQuery()
  const search = query.get('q') || ''
  const filter = query.get('filter') || 'all'
  const sort = query.get('sort') === 'desc' ? 'desc' : 'asc'
  const filtered = items
    .filter((item) => text(item).toLowerCase().includes(search.toLowerCase()) && matches(item, filter))
    .sort((a, b) => text(a).localeCompare(text(b)) * (sort === 'desc' ? -1 : 1))
  const pages = Math.max(1, Math.ceil(filtered.length / 20))
  const requestedPage = Number(query.get('page'))
  const page = Number.isSafeInteger(requestedPage) ? Math.min(pages, Math.max(1, requestedPage)) : 1
  return {
    search,
    filter,
    sort,
    page,
    pages,
    total: filtered.length,
    rows: filtered.slice((page - 1) * 20, page * 20),
    change,
    query,
  }
}

export function CollectionToolbar({
  label,
  state,
  filters,
}: {
  label: string
  state: Pick<ReturnType<typeof useCollection>, 'search' | 'filter' | 'sort' | 'change'>
  filters?: { value: string; label: string }[]
}) {
  return (
    <div className="flex flex-wrap gap-3">
      <Input
        type="search"
        aria-label={`Search ${label}`}
        placeholder={`Search ${label}…`}
        value={state.search}
        onChange={(event) => state.change({ q: event.target.value, page: '' })}
        className="min-h-10 w-full text-base sm:w-64 sm:text-sm"
      />
      {filters ? (
        <div className="min-w-40">
          <SettingsSelect
            name="filter"
            aria-label={`Filter ${label}`}
            value={state.filter}
            onValueChange={(value) => state.change({ filter: value, page: '' })}
            options={[{ value: 'all', label: 'All' }, ...filters]}
          />
        </div>
      ) : null}
      <div className="min-w-36">
        <SettingsSelect
          name="sort"
          aria-label={`Sort ${label}`}
          value={state.sort}
          onValueChange={(value) => state.change({ sort: value, page: '' })}
          options={[
            { value: 'asc', label: 'Name: A–Z' },
            { value: 'desc', label: 'Name: Z–A' },
          ]}
        />
      </div>
    </div>
  )
}
export function CollectionPagination({
  state,
}: {
  state: Pick<ReturnType<typeof useCollection>, 'page' | 'pages' | 'total' | 'change'>
}) {
  return (
    <div className="flex flex-wrap items-center justify-between gap-3 text-xs text-zinc-400">
      <p role="status">
        {state.total} results · Page {state.page} of {state.pages}
      </p>
      <div className="flex gap-2">
        <Button
          variant="outline"
          size="sm"
          disabled={state.page <= 1}
          onClick={() => state.change({ page: String(state.page - 1) })}
        >
          Previous
        </Button>
        <Button
          variant="outline"
          size="sm"
          disabled={state.page >= state.pages}
          onClick={() => state.change({ page: String(state.page + 1) })}
        >
          Next
        </Button>
      </div>
    </div>
  )
}
