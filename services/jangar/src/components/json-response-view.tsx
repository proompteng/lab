import * as React from 'react'

import { Button } from '@proompteng/design/ui'
import { cn } from '@/lib/utils'

type JsonResponseViewProps = {
  title: string
  requestPath: string
  className?: string
}

export function JsonResponseView({ title, requestPath, className }: JsonResponseViewProps) {
  const [isLoading, setIsLoading] = React.useState(true)
  const [error, setError] = React.useState<string | null>(null)
  const [payload, setPayload] = React.useState<unknown>(null)

  const load = React.useCallback(async () => {
    setIsLoading(true)
    setError(null)
    try {
      const response = await fetch(requestPath, {
        headers: { accept: 'application/json' },
      })

      const contentType = response.headers.get('content-type') ?? ''
      if (!response.ok) {
        const text = await response.text().catch(() => '')
        setError(`${response.status} ${response.statusText}${text ? `\n${text}` : ''}`)
        return
      }

      if (!contentType.includes('application/json')) {
        const text = await response.text().catch(() => '')
        setError(`Expected JSON but got ${contentType || 'unknown content-type'}.\n${text}`)
        return
      }

      setPayload(await response.json())
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Request failed')
    } finally {
      setIsLoading(false)
    }
  }, [requestPath])

  React.useEffect(() => {
    void load()
  }, [load])

  const pretty = React.useMemo(() => {
    if (payload === null || payload === undefined) return ''
    return JSON.stringify(payload, null, 2)
  }, [payload])

  return (
    <main className={cn('mx-auto w-full max-w-4xl p-6 space-y-4', className)}>
      <header className="flex flex-wrap items-center justify-between gap-3">
        <div className="space-y-1">
          <h1 className="text-sm font-medium">{title}</h1>
          <p className="text-xs text-muted-foreground">
            <code className="font-mono">{requestPath}</code>
          </p>
        </div>
        <Button variant="outline" onClick={load} disabled={isLoading}>
          Refresh
        </Button>
      </header>

      {isLoading ? (
        <div className="text-xs text-muted-foreground" aria-live="polite">
          Loading…
        </div>
      ) : error ? (
        <pre className="whitespace-pre-wrap rounded-none border bg-background p-4 text-xs text-destructive">
          {error}
        </pre>
      ) : (
        <pre className="overflow-auto rounded-none border bg-background p-4 text-xs">
          <code className="font-mono tabular-nums">{pretty}</code>
        </pre>
      )}
    </main>
  )
}
