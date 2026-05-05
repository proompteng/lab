import * as React from 'react'

import { cn } from '@/lib/utils'

type MetricTone = 'default' | 'success' | 'warning' | 'danger'

export function TorghutMetricTile({
  label,
  value,
  tone = 'default',
  compact = false,
}: {
  label: string
  value: React.ReactNode
  tone?: MetricTone
  compact?: boolean
}) {
  let toneClass = 'text-foreground'
  if (tone === 'success') {
    toneClass = 'text-emerald-600'
  } else if (tone === 'warning') {
    toneClass = 'text-amber-600'
  } else if (tone === 'danger') {
    toneClass = 'text-rose-600'
  }

  return (
    <div className="rounded-none border bg-card p-3">
      <div className="text-xs font-medium uppercase tracking-widest text-muted-foreground">{label}</div>
      <div className={cn('mt-2 font-medium tabular-nums', compact ? 'text-xl' : 'text-2xl', toneClass)}>{value}</div>
    </div>
  )
}
