import {
  Button,
  Combobox,
  ComboboxContent,
  ComboboxEmpty,
  ComboboxInput,
  ComboboxItem,
  ComboboxList,
} from '@proompteng/design/ui'
import { createFileRoute } from '@tanstack/react-router'
import { type FormEvent, useCallback, useEffect, useId, useMemo, useState } from 'react'

import { randomUuid } from '@/lib/uuid'

type SymbolItem = {
  assetClass: 'equity' | 'crypto'
  enabled: boolean
  symbol: string
  updatedAt: string
}

const EQUITY_SYMBOL_PATTERN = /^[A-Z][A-Z0-9.-]{0,11}$/
const CRYPTO_SYMBOL_PATTERN = /^[A-Z]{2,10}(?:[-/](?:USD|USDT|USDC|EUR|GBP|JPY|CAD|AUD|INR|BTC|ETH))$/

const normalizeSymbol = (value: string) => value.trim().toUpperCase()

const isValidSymbolForAssetClass = (symbol: string, assetClass: 'equity' | 'crypto') => {
  if (assetClass === 'crypto') return CRYPTO_SYMBOL_PATTERN.test(symbol)
  return EQUITY_SYMBOL_PATTERN.test(symbol)
}

export const Route = createFileRoute('/torghut/symbols')({
  component: TorghutSymbols,
})

function TorghutSymbols() {
  const [items, setItems] = useState<SymbolItem[]>([])
  const [assetClass, setAssetClass] = useState<'equity' | 'crypto'>('equity')
  const [symbolQuery, setSymbolQuery] = useState('')
  const [candidateSymbols, setCandidateSymbols] = useState<string[]>([])
  const [isCandidateLoading, setIsCandidateLoading] = useState(false)
  const [listStatus, setListStatus] = useState<string | null>(null)
  const [formError, setFormError] = useState<string | null>(null)
  const [isSaving, setIsSaving] = useState(false)
  const [pendingDeleteSymbol, setPendingDeleteSymbol] = useState<string | null>(null)
  const symbolInputId = useId()

  const enabledCount = useMemo(() => items.filter((item) => item.enabled).length, [items])

  const refresh = useCallback(async () => {
    setListStatus(null)
    const res = await fetch(`/api/torghut/symbols?includeDisabled=true&format=full&assetClass=${assetClass}`)
    if (!res.ok) throw new Error(`Failed to load symbols (${res.status})`)
    const json = (await res.json()) as { items: SymbolItem[] }
    setItems(json.items)
  }, [assetClass])

  useEffect(() => {
    refresh().catch((err: unknown) => {
      const message = err instanceof Error ? err.message : String(err)
      setListStatus(message)
    })
  }, [refresh])

  const normalizedSymbolQuery = useMemo(() => normalizeSymbol(symbolQuery), [symbolQuery])

  useEffect(() => {
    let isCancelled = false
    if (normalizedSymbolQuery.length === 0) {
      setCandidateSymbols([])
      setIsCandidateLoading(false)
      return () => {
        isCancelled = true
      }
    }

    const timeout = setTimeout(() => {
      setIsCandidateLoading(true)
      const query = new URLSearchParams()
      query.set('assetClass', assetClass)
      query.set('limit', '40')
      query.set('q', normalizedSymbolQuery)

      fetch(`/api/torghut/symbols/search?${query.toString()}`)
        .then(async (res) => {
          const payload = (await res.json().catch(() => null)) as { symbols?: string[] } | null
          if (isCancelled) return
          if (!res.ok || !Array.isArray(payload?.symbols)) {
            setCandidateSymbols([])
            return
          }
          setCandidateSymbols(payload.symbols.map((symbol) => normalizeSymbol(symbol)))
        })
        .catch(() => {
          if (!isCancelled) setCandidateSymbols([])
        })
        .finally(() => {
          if (!isCancelled) setIsCandidateLoading(false)
        })
    }, 180)

    return () => {
      isCancelled = true
      clearTimeout(timeout)
    }
  }, [assetClass, normalizedSymbolQuery])

  const knownSymbols = useMemo(() => {
    const values = new Set<string>()

    for (const item of items) {
      if (item.assetClass !== assetClass) continue
      values.add(normalizeSymbol(item.symbol))
    }

    for (const candidate of candidateSymbols) {
      if (!isValidSymbolForAssetClass(candidate, assetClass)) continue
      values.add(candidate)
    }

    return [...values].sort((a, b) => a.localeCompare(b))
  }, [assetClass, candidateSymbols, items])

  const knownSymbolSet = useMemo(() => new Set(knownSymbols), [knownSymbols])

  const existingSymbolSet = useMemo(
    () => new Set(items.filter((item) => item.assetClass === assetClass).map((item) => normalizeSymbol(item.symbol))),
    [assetClass, items],
  )

  const filteredKnownSymbols = useMemo(() => {
    if (!normalizedSymbolQuery) return knownSymbols.slice(0, 120)
    return knownSymbols.filter((symbol) => symbol.includes(normalizedSymbolQuery)).slice(0, 120)
  }, [knownSymbols, normalizedSymbolQuery])

  const canSubmit =
    normalizedSymbolQuery.length > 0 &&
    knownSymbolSet.has(normalizedSymbolQuery) &&
    !existingSymbolSet.has(normalizedSymbolQuery) &&
    !isSaving

  const submit = useCallback(async () => {
    setFormError(null)

    const normalized = normalizeSymbol(symbolQuery)
    if (!normalized) {
      setFormError('Choose a symbol to add.')
      return
    }
    if (!knownSymbolSet.has(normalized)) {
      setFormError('Select a valid symbol from the combobox list.')
      return
    }
    if (existingSymbolSet.has(normalized)) {
      setFormError(`${normalized} is already in this asset class.`)
      return
    }

    setIsSaving(true)
    try {
      const res = await fetch('/api/torghut/symbols', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'idempotency-key': randomUuid() },
        body: JSON.stringify({ symbols: [normalized], enabled: true, assetClass }),
      })
      const payload = (await res.json().catch(() => null)) as { error?: string; insertedOrUpdated?: number } | null
      if (!res.ok) throw new Error(payload?.error ?? `Failed to save (${res.status})`)
      if ((payload?.insertedOrUpdated ?? 0) < 1) throw new Error('No symbol was added')

      setSymbolQuery('')
      await refresh()
      setListStatus(`Added ${normalized}.`)
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err)
      setFormError(message)
    } finally {
      setIsSaving(false)
    }
  }, [assetClass, existingSymbolSet, knownSymbolSet, refresh, symbolQuery])

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
        body: JSON.stringify({ enabled, assetClass }),
      })
      if (!res.ok) throw new Error(`Failed to update ${symbol} (${res.status})`)
    } catch (err: unknown) {
      setItems(previous)
      const message = err instanceof Error ? err.message : String(err)
      setListStatus(message)
    }
  }

  const deleteSymbol = async (symbol: string) => {
    setListStatus(null)
    setPendingDeleteSymbol(symbol)
    const previous = items
    setItems((current) => current.filter((item) => item.symbol !== symbol))

    try {
      const res = await fetch(`/api/torghut/symbols/${encodeURIComponent(symbol)}?assetClass=${assetClass}`, {
        method: 'DELETE',
      })
      const payload = (await res.json().catch(() => null)) as { error?: string } | null
      if (!res.ok) throw new Error(payload?.error ?? `Failed to delete ${symbol} (${res.status})`)
      setListStatus(`Deleted ${symbol}.`)
    } catch (err: unknown) {
      setItems(previous)
      const message = err instanceof Error ? err.message : String(err)
      setListStatus(message)
    } finally {
      setPendingDeleteSymbol(null)
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
          <div className="flex items-center gap-2 text-xs">
            <label className="text-muted-foreground" htmlFor="torghut-symbol-asset-class">
              Asset class
            </label>
            <select
              id="torghut-symbol-asset-class"
              className="border border-input bg-transparent px-2 py-1 text-xs text-foreground"
              value={assetClass}
              onChange={(event) => setAssetClass(event.target.value === 'crypto' ? 'crypto' : 'equity')}
            >
              <option value="equity">equity</option>
              <option value="crypto">crypto</option>
            </select>
          </div>
        </div>

        <form className="flex w-full flex-wrap items-end gap-2 sm:w-auto" onSubmit={onSubmit}>
          <div className="space-y-1">
            <label className="text-xs text-muted-foreground" htmlFor={symbolInputId}>
              Add symbol
            </label>
            <Combobox
              inputValue={symbolQuery}
              onInputValueChange={(value) => {
                setFormError(null)
                setSymbolQuery(value.toUpperCase())
              }}
              value={normalizedSymbolQuery.length > 0 ? normalizedSymbolQuery : null}
              onValueChange={(value) => {
                setFormError(null)
                setSymbolQuery(value ?? '')
              }}
              autoHighlight
              openOnInputClick
            >
              <ComboboxInput
                id={symbolInputId}
                name="symbol"
                placeholder={isCandidateLoading ? 'Loading symbols…' : 'Search symbol'}
                autoComplete="off"
                showTrigger
                aria-invalid={Boolean(formError)}
              />
              <ComboboxContent>
                <ComboboxList>
                  {filteredKnownSymbols.map((symbol) => (
                    <ComboboxItem key={symbol} value={symbol}>
                      <span className="font-mono text-foreground">{symbol}</span>
                    </ComboboxItem>
                  ))}
                  <ComboboxEmpty>
                    {isCandidateLoading ? 'Searching symbols…' : 'No matching symbols found.'}
                  </ComboboxEmpty>
                </ComboboxList>
              </ComboboxContent>
            </Combobox>
          </div>
          <Button type="submit" disabled={!canSubmit} aria-busy={isSaving}>
            {isSaving ? (
              <span className="mr-2 size-3 animate-spin rounded-full border border-current border-t-transparent motion-reduce:animate-none" />
            ) : null}
            <span>Add symbol</span>
          </Button>
        </form>
      </header>

      {formError ? (
        <p className="text-xs text-destructive" role="alert">
          {formError}
        </p>
      ) : (
        <p className="text-xs text-muted-foreground">
          Type to search internet symbol data, then pick from the combobox list. Free-form comma-separated entry is
          removed.
        </p>
      )}

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
                <th className="px-3 py-2 font-medium text-right">Actions</th>
              </tr>
            </thead>
            <tbody>
              {items.length === 0 ? (
                <tr>
                  <td colSpan={4} className="px-3 py-6 text-center text-muted-foreground">
                    No symbols yet. Add your first symbol to start tracking.
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
                    <td className="px-3 py-2 text-right">
                      <button
                        type="button"
                        className="rounded border border-red-500/40 px-2 py-1 text-xs text-red-200 transition-colors hover:bg-red-500/10 disabled:cursor-not-allowed disabled:opacity-60"
                        disabled={pendingDeleteSymbol === item.symbol}
                        onClick={() => void deleteSymbol(item.symbol)}
                      >
                        {pendingDeleteSymbol === item.symbol ? 'Deleting…' : 'Delete'}
                      </button>
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
