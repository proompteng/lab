import { createFileRoute } from '@tanstack/react-router'
import { type FormEvent, useCallback, useEffect, useId, useMemo, useRef, useState } from 'react'

import { Button } from '@/components/ui/button'

type SymbolItem = {
  assetClass: 'equity' | 'crypto'
  enabled: boolean
  symbol: string
  updatedAt: string
}

export const Route = createFileRoute('/torghut/symbols')({
  component: TorghutSymbols,
})

function TorghutSymbols() {
  const [items, setItems] = useState<SymbolItem[]>([])
  const [symbolsText, setSymbolsText] = useState('')
  const [status, setStatus] = useState<string | null>(null)
  const [isSaving, setIsSaving] = useState(false)
  const symbolsTextId = useId()
  const symbolsTextRef = useRef<HTMLTextAreaElement | null>(null)

  const enabledCount = useMemo(() => items.filter((item) => item.enabled).length, [items])

  const refresh = useCallback(async () => {
    const res = await fetch('/api/torghut/symbols?includeDisabled=true&format=full')
    if (!res.ok) throw new Error(`Failed to load symbols (${res.status})`)
    const json = (await res.json()) as { items: SymbolItem[] }
    setItems(json.items)
  }, [])

  useEffect(() => {
    refresh().catch((err: unknown) => {
      const message = err instanceof Error ? err.message : String(err)
      setStatus(message)
    })
  }, [refresh])

  const submit = useCallback(async () => {
    setStatus(null)
    const trimmed = symbolsText.trim()
    if (!trimmed) {
      setStatus('Enter at least one symbol to save.')
      symbolsTextRef.current?.focus()
      return
    }

    setIsSaving(true)
    try {
      const res = await fetch('/api/torghut/symbols', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'idempotency-key': crypto.randomUUID() },
        body: JSON.stringify({ symbolsText: trimmed, enabled: true, assetClass: 'equity' }),
      })
      if (!res.ok) throw new Error(`Failed to save (${res.status})`)
      setSymbolsText('')
      await refresh()
      setStatus('Saved.')
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err)
      setStatus(message)
    } finally {
      setIsSaving(false)
    }
  }, [refresh, symbolsText])

  const onSubmit = (event: FormEvent) => {
    event.preventDefault()
    void submit()
  }

  const setEnabled = async (symbol: string, enabled: boolean) => {
    setStatus(null)
    const previous = items
    setItems((current) => current.map((item) => (item.symbol === symbol ? { ...item, enabled } : item)))
    try {
      const res = await fetch(`/api/torghut/symbols/${encodeURIComponent(symbol)}`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ enabled }),
      })
      if (!res.ok) throw new Error(`Failed to update ${symbol} (${res.status})`)
    } catch (err: unknown) {
      setItems(previous)
      const message = err instanceof Error ? err.message : String(err)
      setStatus(message)
    }
  }

  return (
    <main className="mx-auto w-full max-w-5xl space-y-6 p-6">
      <header className="space-y-2">
        <p className="text-xs font-medium uppercase tracking-widest text-muted-foreground">Torghut</p>
        <h1 className="text-lg font-semibold">Symbols</h1>
        <p className="text-xs text-muted-foreground">
          Enabled <span className="tabular-nums">{enabledCount}</span> of{' '}
          <span className="tabular-nums">{items.length}</span>
        </p>
      </header>

      <section className="space-y-3 rounded-none border bg-card p-4">
        <h2 className="text-sm font-medium">Bulk add / enable</h2>
        <form className="space-y-3" onSubmit={onSubmit}>
          <label className="block text-xs text-muted-foreground" htmlFor={symbolsTextId}>
            Symbols (comma, space, or newline separated)
          </label>
          <textarea
            ref={symbolsTextRef}
            id={symbolsTextId}
            name="symbolsText"
            className="min-h-28 w-full rounded-none border border-input bg-transparent px-2.5 py-2 text-xs leading-6 text-foreground placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring/50"
            placeholder="NVDA, AAPL, MSFT…"
            value={symbolsText}
            onChange={(event) => setSymbolsText(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
                event.preventDefault()
                void submit()
              }
            }}
          />
          <Button type="submit" disabled={isSaving} aria-busy={isSaving}>
            {isSaving ? (
              <span className="mr-2 size-3 animate-spin rounded-full border border-current border-t-transparent motion-reduce:animate-none" />
            ) : null}
            <span>Save</span>
          </Button>
        </form>
        <p aria-live="polite" className="text-xs text-muted-foreground">
          {status ?? ''}
        </p>
      </section>

      <section className="overflow-hidden rounded-none border bg-card">
        <table className="w-full text-xs">
          <thead className="border-b bg-muted/30 text-muted-foreground">
            <tr className="text-left uppercase tracking-widest">
              <th className="px-3 py-2 font-medium">Symbol</th>
              <th className="px-3 py-2 font-medium">Asset</th>
              <th className="px-3 py-2 font-medium text-right">Enabled</th>
            </tr>
          </thead>
          <tbody>
            {items.map((item) => (
              <tr key={item.symbol} className="border-b last:border-b-0">
                <td className="px-3 py-2 font-medium text-foreground">{item.symbol}</td>
                <td className="px-3 py-2 text-muted-foreground">{item.assetClass}</td>
                <td className="px-3 py-2">
                  <label className="flex items-center justify-end gap-2 rounded-none px-2 py-1">
                    <span className="text-muted-foreground">Enabled</span>
                    <input
                      type="checkbox"
                      checked={item.enabled}
                      onChange={(event) => setEnabled(item.symbol, event.target.checked)}
                      className="h-5 w-5"
                    />
                  </label>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>
    </main>
  )
}
