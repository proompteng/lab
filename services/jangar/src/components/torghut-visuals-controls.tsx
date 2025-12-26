import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'
import type { IndicatorState, RangeOption, ResolutionOption } from './torghut-visuals-types'

const selectClassName =
  'border-input focus-visible:border-ring focus-visible:ring-ring/50 rounded-none border bg-transparent px-2.5 py-1 text-xs text-foreground focus-visible:ring-1 outline-none'

type TorghutVisualsControlsProps = {
  symbols: string[]
  selectedSymbol: string
  onSymbolChange: (value: string) => void
  rangeOptions: RangeOption[]
  range: RangeOption
  onRangeChange: (value: string) => void
  resolutionOptions: ResolutionOption[]
  resolution: ResolutionOption
  onResolutionChange: (value: string) => void
  indicators: IndicatorState
  onIndicatorToggle: (value: keyof IndicatorState) => void
  onRefresh: () => void
  isRefreshing: boolean
  queryLimit: number
  maxPoints: number
  disabled?: boolean
}

export function TorghutVisualsControls({
  symbols,
  selectedSymbol,
  onSymbolChange,
  rangeOptions,
  range,
  onRangeChange,
  resolutionOptions,
  resolution,
  onResolutionChange,
  indicators,
  onIndicatorToggle,
  onRefresh,
  isRefreshing,
  queryLimit,
  maxPoints,
  disabled = false,
}: TorghutVisualsControlsProps) {
  return (
    <section className="space-y-3 rounded-none border bg-card p-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="text-xs font-medium uppercase tracking-widest text-muted-foreground">Controls</div>
        <Button variant="outline" size="sm" onClick={onRefresh} disabled={disabled || isRefreshing}>
          {isRefreshing ? (
            <span className="mr-2 size-3 animate-spin rounded-full border border-current border-t-transparent motion-reduce:animate-none" />
          ) : null}
          <span>Refresh</span>
        </Button>
      </div>

      <div className="grid gap-4 md:grid-cols-3">
        <div className="space-y-1">
          <label className="text-xs font-medium text-muted-foreground" htmlFor="torghut-symbol">
            Symbol
          </label>
          <select
            id="torghut-symbol"
            className={cn(selectClassName, 'w-full')}
            value={selectedSymbol}
            onChange={(event) => onSymbolChange(event.target.value)}
            disabled={disabled || symbols.length === 0}
          >
            {symbols.length === 0 ? <option value="">No symbols enabled</option> : null}
            {symbols.map((symbol) => (
              <option key={symbol} value={symbol}>
                {symbol}
              </option>
            ))}
          </select>
        </div>

        <div className="space-y-1">
          <label className="text-xs font-medium text-muted-foreground" htmlFor="torghut-range">
            Time range
          </label>
          <select
            id="torghut-range"
            className={cn(selectClassName, 'w-full')}
            value={range.id}
            onChange={(event) => onRangeChange(event.target.value)}
            disabled={disabled}
          >
            {rangeOptions.map((option) => (
              <option key={option.id} value={option.id}>
                {option.label}
              </option>
            ))}
          </select>
        </div>

        <div className="space-y-1">
          <label className="text-xs font-medium text-muted-foreground" htmlFor="torghut-resolution">
            Resolution
          </label>
          <select
            id="torghut-resolution"
            className={cn(selectClassName, 'w-full')}
            value={resolution.id}
            onChange={(event) => onResolutionChange(event.target.value)}
            disabled={disabled}
          >
            {resolutionOptions.map((option) => (
              <option key={option.id} value={option.id}>
                {option.label}
              </option>
            ))}
          </select>
        </div>
      </div>

      <div className="flex flex-wrap items-start gap-6">
        <div className="space-y-2">
          <div className="text-xs font-medium uppercase tracking-widest text-muted-foreground">Overlays</div>
          <div className="flex flex-wrap gap-3">
            <ToggleOption
              label="EMA 12/26"
              checked={indicators.ema}
              onChange={() => onIndicatorToggle('ema')}
              disabled={disabled}
            />
            <ToggleOption
              label="Bollinger"
              checked={indicators.boll}
              onChange={() => onIndicatorToggle('boll')}
              disabled={disabled}
            />
            <ToggleOption
              label="VWAP"
              checked={indicators.vwap}
              onChange={() => onIndicatorToggle('vwap')}
              disabled={disabled}
            />
          </div>
        </div>

        <div className="space-y-2">
          <div className="text-xs font-medium uppercase tracking-widest text-muted-foreground">Signals</div>
          <div className="flex flex-wrap gap-3">
            <ToggleOption
              label="MACD"
              checked={indicators.macd}
              onChange={() => onIndicatorToggle('macd')}
              disabled={disabled}
            />
            <ToggleOption
              label="RSI"
              checked={indicators.rsi}
              onChange={() => onIndicatorToggle('rsi')}
              disabled={disabled}
            />
          </div>
        </div>

        <div className="space-y-2">
          <div className="text-xs font-medium uppercase tracking-widest text-muted-foreground">Query</div>
          <div className="text-xs text-muted-foreground">
            Limit <span className="tabular-nums text-foreground">{queryLimit}</span> /{' '}
            <span className="tabular-nums">{maxPoints}</span> points
          </div>
        </div>
      </div>
    </section>
  )
}

function ToggleOption({
  label,
  checked,
  onChange,
  disabled,
}: {
  label: string
  checked: boolean
  onChange: () => void
  disabled: boolean
}) {
  return (
    <label
      className={cn(
        'flex items-center gap-2 rounded-none border px-2 py-1 text-xs',
        checked ? 'border-foreground/40 bg-muted text-foreground' : 'border-border text-muted-foreground',
        disabled ? 'opacity-60' : 'cursor-pointer',
      )}
    >
      <input type="checkbox" checked={checked} onChange={onChange} disabled={disabled} className="size-4" />
      <span>{label}</span>
    </label>
  )
}
