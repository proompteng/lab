import { createFileRoute } from '@tanstack/react-router'
import * as React from 'react'

import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { enrichAtlas, listAtlasPaths } from '@/data/atlas'

type AtlasEnrichState = {
  repository: string
  ref: string
  path: string
  commit: string
  contentHash: string
}

export const Route = createFileRoute('/atlas/enrich')({
  validateSearch: (search: Record<string, unknown>): AtlasEnrichState => ({
    repository: typeof search.repository === 'string' ? search.repository : '',
    ref: typeof search.ref === 'string' ? search.ref : '',
    path: typeof search.path === 'string' ? search.path : '',
    commit: typeof search.commit === 'string' ? search.commit : '',
    contentHash: typeof search.contentHash === 'string' ? search.contentHash : '',
  }),
  component: AtlasEnrichPage,
})

function AtlasEnrichPage() {
  const searchState = Route.useSearch()

  const [enrichRepository, setEnrichRepository] = React.useState(searchState.repository || 'proompteng/lab')
  const [enrichRef, setEnrichRef] = React.useState(searchState.ref || 'main')
  const [enrichPath, setEnrichPath] = React.useState(searchState.path)
  const [enrichCommit, setEnrichCommit] = React.useState(searchState.commit)
  const [enrichContentHash, setEnrichContentHash] = React.useState(searchState.contentHash)
  const [enrichStatus, setEnrichStatus] = React.useState<string | null>(null)
  const [enrichErrors, setEnrichErrors] = React.useState<{ repository?: string; ref?: string; path?: string }>({})
  const [isEnriching, setIsEnriching] = React.useState(false)
  const [pathSuggestions, setPathSuggestions] = React.useState<string[]>([])
  const [pathStatus, setPathStatus] = React.useState<string | null>(null)
  const [isLoadingPaths, setIsLoadingPaths] = React.useState(false)

  const enrichRepositoryRef = React.useRef<HTMLInputElement | null>(null)
  const enrichRefRef = React.useRef<HTMLInputElement | null>(null)
  const enrichPathRef = React.useRef<HTMLInputElement | null>(null)
  const pathListId = React.useId()

  React.useEffect(() => {
    setEnrichRepository(searchState.repository || 'proompteng/lab')
    setEnrichRef(searchState.ref || 'main')
    setEnrichPath(searchState.path)
    setEnrichCommit(searchState.commit)
    setEnrichContentHash(searchState.contentHash)
    setEnrichErrors({})
    setEnrichStatus(null)
  }, [searchState.commit, searchState.contentHash, searchState.path, searchState.ref, searchState.repository])

  React.useEffect(() => {
    const query = enrichPath.trim()
    if (query.length < 2) {
      setPathSuggestions([])
      setPathStatus(null)
      setIsLoadingPaths(false)
      return
    }

    const controller = new AbortController()
    const timeout = setTimeout(() => {
      const run = async () => {
        setIsLoadingPaths(true)
        setPathStatus(null)
        try {
          const result = await listAtlasPaths({
            repository: enrichRepository.trim(),
            ref: enrichRef.trim(),
            query,
            limit: 50,
            signal: controller.signal,
          })
          if (controller.signal.aborted) return
          if (!result.ok) {
            setPathSuggestions([])
            setPathStatus(result.message)
          } else {
            setPathSuggestions(result.paths)
            setPathStatus(result.paths.length === 0 ? 'No matching paths found.' : null)
          }
        } catch (error: unknown) {
          if (controller.signal.aborted) return
          const message = error instanceof Error ? error.message : String(error)
          setPathSuggestions([])
          setPathStatus(message)
        } finally {
          if (!controller.signal.aborted) setIsLoadingPaths(false)
        }
      }

      void run()
    }, 200)

    return () => {
      controller.abort()
      clearTimeout(timeout)
      setIsLoadingPaths(false)
    }
  }, [enrichPath, enrichRef, enrichRepository])

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

  const hasPrefill = Boolean(searchState.path || searchState.commit || searchState.contentHash)

  return (
    <main className="mx-auto w-full max-w-6xl space-y-4 p-4">
      <header className="space-y-2">
        <h1 className="text-lg font-semibold">Enrichment</h1>
        <p className="text-xs text-muted-foreground">
          {hasPrefill ? 'Prefilled from a file selection.' : 'Provide repository, ref, and path to request enrichment.'}
        </p>
      </header>

      <section className="rounded-none border bg-card p-4">
        <form className="space-y-3" onSubmit={submitEnrich}>
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
                list={pathListId}
              />
              {enrichErrors.path ? (
                <p className="text-xs text-destructive" role="alert">
                  {enrichErrors.path}
                </p>
              ) : null}
              <datalist id={pathListId}>
                {pathSuggestions.map((path) => (
                  <option key={path} value={path} />
                ))}
              </datalist>
              {isLoadingPaths || pathStatus ? (
                <p className="text-xs text-muted-foreground" aria-live="polite">
                  {isLoadingPaths ? 'Loading suggestions…' : pathStatus}
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
