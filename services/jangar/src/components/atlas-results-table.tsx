import { buttonVariants } from '@proompteng/design/ui'
import { Link } from '@tanstack/react-router'
import type * as React from 'react'
import type { AtlasFileItem } from '@/data/atlas'
import { cn } from '@/lib/utils'

type AtlasAction = {
  to: string
  search?: Record<string, string>
}

type AtlasSectionHeaderProps = {
  title: string
  subtitle?: string
  count?: number
  actions?: React.ReactNode
}

export function AtlasSectionHeader({ title, subtitle, count, actions }: AtlasSectionHeaderProps) {
  return (
    <header className="flex flex-wrap items-center justify-between gap-2">
      <div className="space-y-1">
        <h2 className="text-sm font-semibold">{title}</h2>
        {subtitle ? <p className="text-xs text-muted-foreground">{subtitle}</p> : null}
      </div>
      <div className="flex items-center gap-2 text-xs text-muted-foreground">
        {typeof count === 'number' ? <span className="tabular-nums">{count} items</span> : null}
        {actions}
      </div>
    </header>
  )
}

type AtlasResultsTableProps = {
  items: AtlasFileItem[]
  emptyLabel: string
  actionLabel: string
  getAction: (item: AtlasFileItem) => AtlasAction
}

export function AtlasResultsTable({ items, emptyLabel, actionLabel, getAction }: AtlasResultsTableProps) {
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
              const action = getAction(item)
              return (
                <tr key={key} className="border-b last:border-b-0">
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
                    <Link
                      to={action.to}
                      search={action.search}
                      className={cn(buttonVariants({ variant: 'outline', size: 'xs' }))}
                    >
                      {actionLabel}
                    </Link>
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
