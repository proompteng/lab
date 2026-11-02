import { Button } from '@proompteng/design/ui'
import { createFileRoute } from '@tanstack/react-router'
import * as React from 'react'
import { AtlasResultsTable, AtlasSectionHeader } from '@/components/atlas-results-table'
import type { AtlasFileItem } from '@/data/atlas'
import { listAtlasIndexedFiles } from '@/data/atlas'

export const Route = createFileRoute('/atlas/indexed')({
  component: AtlasIndexedPage,
})

function AtlasIndexedPage() {
  const [indexedFiles, setIndexedFiles] = React.useState<AtlasFileItem[]>([])
  const [indexedStatus, setIndexedStatus] = React.useState<string | null>(null)
  const [isLoadingIndex, setIsLoadingIndex] = React.useState(false)

  const loadIndexedFiles = React.useCallback(async () => {
    setIsLoadingIndex(true)
    setIndexedStatus(null)
    try {
      const result = await listAtlasIndexedFiles({ limit: 50 })
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
        <h1 className="text-lg font-semibold">Indexed files</h1>
        <p className="text-xs text-muted-foreground">Review recent indexed entries and jump to enrichment.</p>
      </header>

      <section className="space-y-2">
        <AtlasSectionHeader
          title="Results"
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
