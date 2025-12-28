import * as React from 'react'

import { cn } from '@/lib/utils'
import type { IndicatorState, TorghutBar, TorghutSignal } from './torghut-visuals-types'

type EChartsModule = typeof import('echarts')
type EChartsInstance = ReturnType<EChartsModule['init']>

type TorghutVisualsChartProps = {
  bars: TorghutBar[]
  signals: TorghutSignal[]
  indicators: IndicatorState
  className?: string
}

type OverlaySeriesData = {
  ema12: LinePoint[]
  ema26: LinePoint[]
  bollUpper: LinePoint[]
  bollMid: LinePoint[]
  bollLower: LinePoint[]
  vwapSession: LinePoint[]
  vwapW5m: LinePoint[]
}

type OscillatorSeriesData = {
  macd: LinePoint[]
  macdSignal: LinePoint[]
  rsi: LinePoint[]
}

type CandlePoint = {
  time: number
  open: number
  high: number
  low: number
  close: number
}

type LinePoint = {
  time: number
  value: number
}

export function TorghutVisualsChart({ bars, signals, indicators, className }: TorghutVisualsChartProps) {
  const candleData = React.useMemo(() => buildCandles(bars), [bars])
  const overlays = React.useMemo(() => buildOverlays(signals), [signals])
  const oscillators = React.useMemo(() => buildOscillators(signals), [signals])
  const showSignals = indicators.macd || indicators.rsi

  return (
    <div className={cn('space-y-4', className)}>
      <div className="space-y-2">
        <div className="text-xs font-medium uppercase tracking-widest text-muted-foreground">Price</div>
        <div className="relative rounded-none border bg-background">
          <PriceChart candles={candleData} overlays={overlays} indicators={indicators} />
          {candleData.length === 0 ? (
            <div className="pointer-events-none absolute inset-0 grid place-items-center text-xs text-muted-foreground">
              No candles for this range.
            </div>
          ) : null}
        </div>
      </div>

      <div className="space-y-2">
        <div className="text-xs font-medium uppercase tracking-widest text-muted-foreground">Signals</div>
        {showSignals ? (
          <div className="relative rounded-none border bg-background">
            <SignalChart oscillators={oscillators} indicators={indicators} />
            {oscillators.macd.length === 0 && oscillators.rsi.length === 0 ? (
              <div className="pointer-events-none absolute inset-0 grid place-items-center text-xs text-muted-foreground">
                No indicator points for this window.
              </div>
            ) : null}
          </div>
        ) : (
          <div className="rounded-none border border-dashed bg-background p-4 text-xs text-muted-foreground">
            Enable MACD or RSI to render the indicator panel.
          </div>
        )}
      </div>
    </div>
  )
}

function PriceChart({
  candles,
  overlays,
  indicators,
}: {
  candles: CandlePoint[]
  overlays: OverlaySeriesData
  indicators: IndicatorState
}) {
  const containerRef = React.useRef<HTMLDivElement | null>(null)
  const chartRef = React.useRef<EChartsInstance | null>(null)
  const resizeRef = React.useRef<ResizeObserver | null>(null)
  const option = React.useMemo(() => buildPriceOption(candles, overlays, indicators), [candles, overlays, indicators])

  React.useEffect(() => {
    let active = true
    const setup = async () => {
      if (!containerRef.current) return
      const echarts = (await import('echarts')) as EChartsModule
      if (!active || !containerRef.current) return

      const chart = echarts.init(containerRef.current, undefined, { renderer: 'canvas' })
      chart.setOption(option, { notMerge: true, lazyUpdate: true })
      chartRef.current = chart

      const observer = new ResizeObserver(() => chart.resize())
      observer.observe(containerRef.current)
      resizeRef.current = observer
    }

    void setup()

    return () => {
      active = false
      resizeRef.current?.disconnect()
      resizeRef.current = null
      chartRef.current?.dispose()
      chartRef.current = null
    }
  }, [option])

  React.useEffect(() => {
    if (!chartRef.current) return
    chartRef.current.setOption(option, { notMerge: true, lazyUpdate: true })
  }, [option])

  return (
    <div
      ref={containerRef}
      className="min-h-[18rem] w-full"
      role="img"
      aria-label="Candlestick chart with indicator overlays"
    />
  )
}

function SignalChart({ oscillators, indicators }: { oscillators: OscillatorSeriesData; indicators: IndicatorState }) {
  const containerRef = React.useRef<HTMLDivElement | null>(null)
  const chartRef = React.useRef<EChartsInstance | null>(null)
  const resizeRef = React.useRef<ResizeObserver | null>(null)
  const option = React.useMemo(() => buildSignalOption(oscillators, indicators), [oscillators, indicators])

  React.useEffect(() => {
    let active = true
    const setup = async () => {
      if (!containerRef.current) return
      const echarts = (await import('echarts')) as EChartsModule
      if (!active || !containerRef.current) return

      const chart = echarts.init(containerRef.current, undefined, { renderer: 'canvas' })
      chart.setOption(option, { notMerge: true, lazyUpdate: true })
      chartRef.current = chart

      const observer = new ResizeObserver(() => chart.resize())
      observer.observe(containerRef.current)
      resizeRef.current = observer
    }

    void setup()

    return () => {
      active = false
      resizeRef.current?.disconnect()
      resizeRef.current = null
      chartRef.current?.dispose()
      chartRef.current = null
    }
  }, [option])

  React.useEffect(() => {
    if (!chartRef.current) return
    chartRef.current.setOption(option, { notMerge: true, lazyUpdate: true })
  }, [option])

  return (
    <div ref={containerRef} className="min-h-[14rem] w-full" role="img" aria-label="Indicator chart for MACD and RSI" />
  )
}

const buildCandles = (bars: TorghutBar[]): CandlePoint[] => {
  const points: CandlePoint[] = []
  for (const bar of bars) {
    const time = toTimestamp(bar.event_ts ?? bar.eventTs ?? bar.ts ?? bar.time)
    if (!time) continue
    const open = toNumber(bar.o ?? bar.open)
    const high = toNumber(bar.h ?? bar.high)
    const low = toNumber(bar.l ?? bar.low)
    const close = toNumber(bar.c ?? bar.close)
    if (open === null || high === null || low === null || close === null) continue
    points.push({ time, open, high, low, close })
  }
  return points.sort(sortByTime)
}

const buildOverlays = (signals: TorghutSignal[]): OverlaySeriesData => {
  const ema12: LinePoint[] = []
  const ema26: LinePoint[] = []
  const bollUpper: LinePoint[] = []
  const bollMid: LinePoint[] = []
  const bollLower: LinePoint[] = []
  const vwapSession: LinePoint[] = []
  const vwapW5m: LinePoint[] = []

  for (const signal of signals) {
    const time = toTimestamp(signal.event_ts ?? signal.eventTs ?? signal.ts ?? signal.time)
    if (!time) continue

    if (signal.ema) {
      const ema12Value = toNumber(signal.ema.ema12)
      const ema26Value = toNumber(signal.ema.ema26)
      if (ema12Value !== null) ema12.push({ time, value: ema12Value })
      if (ema26Value !== null) ema26.push({ time, value: ema26Value })
    }

    if (signal.boll) {
      const upper = toNumber(signal.boll.upper)
      const mid = toNumber(signal.boll.mid)
      const lower = toNumber(signal.boll.lower)
      if (upper !== null) bollUpper.push({ time, value: upper })
      if (mid !== null) bollMid.push({ time, value: mid })
      if (lower !== null) bollLower.push({ time, value: lower })
    }

    if (signal.vwap) {
      const session = toNumber(signal.vwap.session)
      const w5m = toNumber(signal.vwap.w5m)
      if (session !== null) vwapSession.push({ time, value: session })
      if (w5m !== null) vwapW5m.push({ time, value: w5m })
    }
  }

  return {
    ema12: ema12.sort(sortByTime),
    ema26: ema26.sort(sortByTime),
    bollUpper: bollUpper.sort(sortByTime),
    bollMid: bollMid.sort(sortByTime),
    bollLower: bollLower.sort(sortByTime),
    vwapSession: vwapSession.sort(sortByTime),
    vwapW5m: vwapW5m.sort(sortByTime),
  }
}

const buildOscillators = (signals: TorghutSignal[]): OscillatorSeriesData => {
  const macd: LinePoint[] = []
  const macdSignal: LinePoint[] = []
  const rsi: LinePoint[] = []

  for (const signal of signals) {
    const time = toTimestamp(signal.event_ts ?? signal.eventTs ?? signal.ts ?? signal.time)
    if (!time) continue

    if (signal.macd) {
      const macdValue = toNumber(signal.macd.macd)
      const macdSignalValue = toNumber(signal.macd.signal)
      if (macdValue !== null) macd.push({ time, value: macdValue })
      if (macdSignalValue !== null) macdSignal.push({ time, value: macdSignalValue })
    }

    const rsiValue = toNumber(signal.rsi14 ?? signal.rsi_14)
    if (rsiValue !== null) rsi.push({ time, value: rsiValue })
  }

  return {
    macd: macd.sort(sortByTime),
    macdSignal: macdSignal.sort(sortByTime),
    rsi: rsi.sort(sortByTime),
  }
}

const toNumber = (value: unknown): number | null => {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value)
    if (Number.isFinite(parsed)) return parsed
  }
  return null
}

const toTimestamp = (value: string | undefined): number | null => {
  if (!value) return null
  const parsed = Date.parse(value)
  if (Number.isNaN(parsed)) return null
  return parsed
}

const sortByTime = <T extends { time: number }>(a: T, b: T) => a.time - b.time

const buildPriceOption = (candles: CandlePoint[], overlays: OverlaySeriesData, indicators: IndicatorState) => {
  const series = [
    {
      name: 'Candles',
      type: 'candlestick',
      data: candles.map((point) => [point.time, point.open, point.close, point.low, point.high]),
      itemStyle: {
        color: '#16a34a',
        color0: '#dc2626',
        borderColor: '#16a34a',
        borderColor0: '#dc2626',
      },
    },
    {
      name: 'EMA 12',
      type: 'line',
      data: indicators.ema ? overlays.ema12.map((point) => [point.time, point.value]) : [],
      showSymbol: false,
      lineStyle: { width: 1, color: '#0ea5e9' },
    },
    {
      name: 'EMA 26',
      type: 'line',
      data: indicators.ema ? overlays.ema26.map((point) => [point.time, point.value]) : [],
      showSymbol: false,
      lineStyle: { width: 1, color: '#f97316' },
    },
    {
      name: 'Boll Upper',
      type: 'line',
      data: indicators.boll ? overlays.bollUpper.map((point) => [point.time, point.value]) : [],
      showSymbol: false,
      lineStyle: { width: 1, color: '#facc15' },
    },
    {
      name: 'Boll Mid',
      type: 'line',
      data: indicators.boll ? overlays.bollMid.map((point) => [point.time, point.value]) : [],
      showSymbol: false,
      lineStyle: { width: 1, color: '#a855f7' },
    },
    {
      name: 'Boll Lower',
      type: 'line',
      data: indicators.boll ? overlays.bollLower.map((point) => [point.time, point.value]) : [],
      showSymbol: false,
      lineStyle: { width: 1, color: '#facc15' },
    },
    {
      name: 'VWAP Session',
      type: 'line',
      data: indicators.vwap ? overlays.vwapSession.map((point) => [point.time, point.value]) : [],
      showSymbol: false,
      lineStyle: { width: 1, color: '#22c55e' },
    },
    {
      name: 'VWAP 5m',
      type: 'line',
      data: indicators.vwap ? overlays.vwapW5m.map((point) => [point.time, point.value]) : [],
      showSymbol: false,
      lineStyle: { width: 1, color: '#84cc16' },
    },
  ]

  return {
    animation: false,
    backgroundColor: 'transparent',
    grid: { left: 48, right: 24, top: 24, bottom: 32 },
    tooltip: { trigger: 'axis', axisPointer: { type: 'cross' } },
    xAxis: {
      type: 'time',
      axisLabel: { color: '#a1a1aa' },
      axisLine: { lineStyle: { color: 'rgba(63, 63, 70, 0.4)' } },
      splitLine: { lineStyle: { color: 'rgba(63, 63, 70, 0.2)' } },
    },
    yAxis: {
      scale: true,
      axisLabel: { color: '#a1a1aa' },
      splitLine: { lineStyle: { color: 'rgba(63, 63, 70, 0.2)' } },
    },
    series,
  }
}

const buildSignalOption = (oscillators: OscillatorSeriesData, indicators: IndicatorState) => {
  const macdData = indicators.macd ? oscillators.macd.map((point) => [point.time, point.value]) : []
  const macdSignalData = indicators.macd ? oscillators.macdSignal.map((point) => [point.time, point.value]) : []
  const rsiData = indicators.rsi ? oscillators.rsi.map((point) => [point.time, point.value]) : []

  return {
    animation: false,
    backgroundColor: 'transparent',
    grid: { left: 48, right: 48, top: 24, bottom: 32 },
    tooltip: { trigger: 'axis', axisPointer: { type: 'line' } },
    xAxis: {
      type: 'time',
      axisLabel: { color: '#a1a1aa' },
      axisLine: { lineStyle: { color: 'rgba(63, 63, 70, 0.4)' } },
      splitLine: { lineStyle: { color: 'rgba(63, 63, 70, 0.2)' } },
    },
    yAxis: [
      {
        scale: true,
        axisLabel: { color: '#a1a1aa' },
        splitLine: { lineStyle: { color: 'rgba(63, 63, 70, 0.2)' } },
      },
      {
        scale: true,
        axisLabel: { color: '#a1a1aa' },
        splitLine: { show: false },
      },
    ],
    series: [
      {
        name: 'MACD',
        type: 'line',
        data: macdData,
        showSymbol: false,
        lineStyle: { width: 1, color: '#f97316' },
        yAxisIndex: 0,
      },
      {
        name: 'MACD Signal',
        type: 'line',
        data: macdSignalData,
        showSymbol: false,
        lineStyle: { width: 1, color: '#facc15' },
        yAxisIndex: 0,
      },
      {
        name: 'RSI',
        type: 'line',
        data: rsiData,
        showSymbol: false,
        lineStyle: { width: 1, color: '#0ea5e9' },
        yAxisIndex: 1,
      },
    ],
  }
}
