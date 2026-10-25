import { Button, Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@proompteng/design/ui'
import { cn } from '@/lib/utils'
import type { IndicatorState, RangeOption, ResolutionOption } from './torghut-visuals-types'

const selectTriggerClassName =
  'h-auto w-full rounded-none border border-input bg-transparent px-2.5 py-1 text-xs text-foreground shadow-none hover:bg-accent/10 focus-visible:ring-1'

const selectContentClassName =
  'rounded-none border border-border bg-popover/95 p-1 text-popover-foreground backdrop-blur-sm'

const selectItemClassName = 'rounded-none'

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
        <Button
          variant="outline"
          size="sm"
          onClick={onRefresh}
          disabled={disabled || isRefreshing}
          aria-busy={isRefreshing}
        >
          {isRefreshing ? (
            <span
              className="mr-2 size-3 animate-spin rounded-full border border-current border-t-transparent motion-reduce:animate-none"
              aria-hidden="true"
            />
          ) : null}
          <span>Refresh</span>
        </Button>
      </div>

      <div className="grid gap-4 md:grid-cols-3">
        <div className="space-y-1">
          <label className="text-xs font-medium text-muted-foreground" htmlFor="torghut-symbol">
            Symbol
          </label>
          <Select
            value={selectedSymbol || undefined}
            onValueChange={(value) => {
              if (value) onSymbolChange(value)
            }}
            disabled={disabled || symbols.length === 0}
          >
            <SelectTrigger id="torghut-symbol" className={selectTriggerClassName}>
              <SelectValue placeholder={symbols.length === 0 ? 'No symbols enabled' : 'Select symbol'} />
            </SelectTrigger>
            <SelectContent align="start" className={selectContentClassName}>
              {symbols.length === 0 ? (
                <SelectItem value="none" disabled className={selectItemClassName}>
                  No symbols enabled
                </SelectItem>
              ) : null}
              {symbols.map((symbol) => (
                <SelectItem key={symbol} value={symbol} className={selectItemClassName}>
                  {symbol}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        <div className="space-y-1">
          <label className="text-xs font-medium text-muted-foreground" htmlFor="torghut-range">
            Time range
          </label>
          <Select
            value={range.id}
            onValueChange={(value) => {
              if (value) onRangeChange(value)
            }}
            disabled={disabled}
          >
            <SelectTrigger id="torghut-range" className={selectTriggerClassName}>
              <SelectValue placeholder="Select time range" />
            </SelectTrigger>
            <SelectContent align="start" className={selectContentClassName}>
              {rangeOptions.map((option) => (
                <SelectItem key={option.id} value={option.id} className={selectItemClassName}>
                  {option.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        <div className="space-y-1">
          <label className="text-xs font-medium text-muted-foreground" htmlFor="torghut-resolution">
            Resolution
          </label>
          <Select
            value={resolution.id}
            onValueChange={(value) => {
              if (value) onResolutionChange(value)
            }}
            disabled={disabled}
          >
            <SelectTrigger id="torghut-resolution" className={selectTriggerClassName}>
              <SelectValue placeholder="Select resolution" />
            </SelectTrigger>
            <SelectContent align="start" className={selectContentClassName}>
              {resolutionOptions.map((option) => (
                <SelectItem key={option.id} value={option.id} className={selectItemClassName}>
                  {option.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
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
