import {
  Button,
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@proompteng/design/ui'
import { createFileRoute } from '@tanstack/react-router'
import { type FormEvent, useCallback, useEffect, useId, useMemo, useRef, useState } from 'react'
import { randomUuid } from '@/lib/uuid'

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
  const [listStatus, setListStatus] = useState<string | null>(null)
  const [formError, setFormError] = useState<string | null>(null)
  const [isSaving, setIsSaving] = useState(false)
  const [isDialogOpen, setIsDialogOpen] = useState(false)
  const symbolsTextId = useId()
  const symbolsTextRef = useRef<HTMLTextAreaElement | null>(null)

  const enabledCount = useMemo(() => items.filter((item) => item.enabled).length, [items])

  const refresh = useCallback(async () => {
    setListStatus(null)
    const res = await fetch('/api/torghut/symbols?includeDisabled=true&format=full')
    if (!res.ok) throw new Error(`Failed to load symbols (${res.status})`)
    const json = (await res.json()) as { items: SymbolItem[] }
    setItems(json.items)
  }, [])

  useEffect(() => {
    refresh().catch((err: unknown) => {
      const message = err instanceof Error ? err.message : String(err)
      setListStatus(message)
    })
  }, [refresh])

  const submit = useCallback(async () => {
    setFormError(null)
    const trimmed = symbolsText.trim()
    if (!trimmed) {
      setFormError('Enter at least one symbol to save.')
      symbolsTextRef.current?.focus()
      return
    }

    setIsSaving(true)
    try {
      const res = await fetch('/api/torghut/symbols', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'idempotency-key': randomUuid() },
        body: JSON.stringify({ symbolsText: trimmed, enabled: true, assetClass: 'equity' }),
      })
      if (!res.ok) throw new Error(`Failed to save (${res.status})`)
      setSymbolsText('')
      await refresh()
      setListStatus('Saved.')
      setIsDialogOpen(false)
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err)
      setFormError(message)
    } finally {
      setIsSaving(false)
    }
  }, [refresh, symbolsText])

  const onSubmit = (event: FormEvent) => {
    event.preventDefault()
    void submit()
  }

  const setEnabled = async (symbol: string, enabled: boolean) => {
    setListStatus(null)
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
      setListStatus(message)
    }
  }

  return (
    <main className="mx-auto w-full max-w-5xl space-y-6 p-6">
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div className="space-y-2">
          <p className="text-xs font-medium uppercase tracking-widest text-muted-foreground">Torghut</p>
          <h1 className="text-lg font-semibold">Symbols</h1>
          <p className="text-xs text-muted-foreground">
            Enabled <span className="tabular-nums">{enabledCount}</span> of{' '}
            <span className="tabular-nums">{items.length}</span>
          </p>
        </div>
        <Dialog
          open={isDialogOpen}
          onOpenChange={(open) => {
            setIsDialogOpen(open)
            if (open) {
              setFormError(null)
              setSymbolsText('')
              setTimeout(() => symbolsTextRef.current?.focus(), 0)
            }
          }}
        >
          <DialogTrigger render={<Button />}>Add symbols</DialogTrigger>
          <DialogContent>
            <DialogHeader>
              <DialogTitle>Add symbols</DialogTitle>
              <DialogDescription>Add one or more symbols separated by commas, spaces, or new lines.</DialogDescription>
            </DialogHeader>
            <form className="space-y-3" onSubmit={onSubmit}>
              <label className="block text-xs text-muted-foreground" htmlFor={symbolsTextId}>
                Symbols
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
              {formError ? (
                <p className="text-xs text-destructive" role="alert">
                  {formError}
                </p>
              ) : null}
              <DialogFooter>
                <DialogClose render={<Button variant="outline" />}>Cancel</DialogClose>
                <Button type="submit" disabled={isSaving} aria-busy={isSaving}>
                  {isSaving ? (
                    <span className="mr-2 size-3 animate-spin rounded-full border border-current border-t-transparent motion-reduce:animate-none" />
                  ) : null}
                  <span>Save</span>
                </Button>
              </DialogFooter>
            </form>
          </DialogContent>
        </Dialog>
      </header>

      <section className="space-y-2">
        {listStatus ? (
          <p aria-live="polite" className="text-xs text-muted-foreground">
            {listStatus}
          </p>
        ) : null}
        <div className="overflow-hidden rounded-none border bg-card">
          <table className="w-full text-xs">
            <thead className="border-b bg-muted/30 text-muted-foreground">
              <tr className="text-left uppercase tracking-widest">
                <th className="px-3 py-2 font-medium">Symbol</th>
                <th className="px-3 py-2 font-medium">Asset</th>
                <th className="px-3 py-2 font-medium text-right">Enabled</th>
              </tr>
            </thead>
            <tbody>
              {items.length === 0 ? (
                <tr>
                  <td colSpan={3} className="px-3 py-6 text-center text-muted-foreground">
                    No symbols yet. Add your first set to start tracking.
                  </td>
                </tr>
              ) : (
                items.map((item) => (
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
                          className="h-6 w-6"
                        />
                      </label>
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </section>
    </main>
  )
}
