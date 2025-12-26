import type { CandlestickData, IChartApi, ISeriesApi, LineData, UTCTimestamp } from 'lightweight-charts'
import * as React from 'react'

import { cn } from '@/lib/utils'
import type { IndicatorState, TorghutBar, TorghutSignal } from './torghut-visuals-types'

type TorghutVisualsChartProps = {
  bars: TorghutBar[]
  signals: TorghutSignal[]
  indicators: IndicatorState
  className?: string
}

type OverlaySeriesData = {
  ema12: LineData[]
  ema26: LineData[]
  bollUpper: LineData[]
  bollMid: LineData[]
  bollLower: LineData[]
  vwapSession: LineData[]
  vwapW5m: LineData[]
}

type OscillatorSeriesData = {
  macd: LineData[]
  macdSignal: LineData[]
  rsi: LineData[]
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
  candles: CandlestickData[]
  overlays: OverlaySeriesData
  indicators: IndicatorState
}) {
  const containerRef = React.useRef<HTMLDivElement | null>(null)
  const chartRef = React.useRef<IChartApi | null>(null)
  const seriesRef = React.useRef<{
    candles: ISeriesApi<'Candlestick'>
    ema12: ISeriesApi<'Line'>
    ema26: ISeriesApi<'Line'>
    bollUpper: ISeriesApi<'Line'>
    bollMid: ISeriesApi<'Line'>
    bollLower: ISeriesApi<'Line'>
    vwapSession: ISeriesApi<'Line'>
    vwapW5m: ISeriesApi<'Line'>
  } | null>(null)

  React.useEffect(() => {
    let active = true
    const setup = async () => {
      if (!containerRef.current) return
      const { createChart, ColorType } = await import('lightweight-charts')
      if (!active || !containerRef.current) return

      const chart = createChart(containerRef.current, {
        autoSize: true,
        layout: {
          background: { type: ColorType.Solid, color: 'transparent' },
          textColor: '#a1a1aa',
          fontSize: 12,
        },
        grid: {
          vertLines: { color: 'rgba(63, 63, 70, 0.2)' },
          horzLines: { color: 'rgba(63, 63, 70, 0.2)' },
        },
        crosshair: {
          vertLine: { color: 'rgba(148, 163, 184, 0.4)' },
          horzLine: { color: 'rgba(148, 163, 184, 0.4)' },
        },
        timeScale: {
          timeVisible: true,
          secondsVisible: true,
        },
        rightPriceScale: {
          borderVisible: false,
        },
      })

      const candlesSeries = chart.addCandlestickSeries({
        upColor: '#16a34a',
        downColor: '#dc2626',
        wickUpColor: '#16a34a',
        wickDownColor: '#dc2626',
        borderUpColor: '#16a34a',
        borderDownColor: '#dc2626',
      })
      const ema12Series = chart.addLineSeries({ color: '#0ea5e9', lineWidth: 1 })
      const ema26Series = chart.addLineSeries({ color: '#f97316', lineWidth: 1 })
      const bollUpperSeries = chart.addLineSeries({ color: '#facc15', lineWidth: 1 })
      const bollMidSeries = chart.addLineSeries({ color: '#a855f7', lineWidth: 1 })
      const bollLowerSeries = chart.addLineSeries({ color: '#facc15', lineWidth: 1 })
      const vwapSessionSeries = chart.addLineSeries({ color: '#22c55e', lineWidth: 1 })
      const vwapW5mSeries = chart.addLineSeries({ color: '#84cc16', lineWidth: 1 })

      chartRef.current = chart
      seriesRef.current = {
        candles: candlesSeries,
        ema12: ema12Series,
        ema26: ema26Series,
        bollUpper: bollUpperSeries,
        bollMid: bollMidSeries,
        bollLower: bollLowerSeries,
        vwapSession: vwapSessionSeries,
        vwapW5m: vwapW5mSeries,
      }
    }

    void setup()

    return () => {
      active = false
      chartRef.current?.remove()
      chartRef.current = null
      seriesRef.current = null
    }
  }, [])

  React.useEffect(() => {
    if (!seriesRef.current) return
    seriesRef.current.candles.setData(candles)
    seriesRef.current.ema12.setData(indicators.ema ? overlays.ema12 : [])
    seriesRef.current.ema26.setData(indicators.ema ? overlays.ema26 : [])
    seriesRef.current.bollUpper.setData(indicators.boll ? overlays.bollUpper : [])
    seriesRef.current.bollMid.setData(indicators.boll ? overlays.bollMid : [])
    seriesRef.current.bollLower.setData(indicators.boll ? overlays.bollLower : [])
    seriesRef.current.vwapSession.setData(indicators.vwap ? overlays.vwapSession : [])
    seriesRef.current.vwapW5m.setData(indicators.vwap ? overlays.vwapW5m : [])

    if (candles.length > 0) {
      chartRef.current?.timeScale().fitContent()
    }
  }, [candles, overlays, indicators])

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
  const chartRef = React.useRef<IChartApi | null>(null)
  const seriesRef = React.useRef<{
    macd: ISeriesApi<'Line'>
    macdSignal: ISeriesApi<'Line'>
    rsi: ISeriesApi<'Line'>
  } | null>(null)

  React.useEffect(() => {
    let active = true
    const setup = async () => {
      if (!containerRef.current) return
      const { createChart, ColorType } = await import('lightweight-charts')
      if (!active || !containerRef.current) return

      const chart = createChart(containerRef.current, {
        autoSize: true,
        layout: {
          background: { type: ColorType.Solid, color: 'transparent' },
          textColor: '#a1a1aa',
          fontSize: 12,
        },
        grid: {
          vertLines: { color: 'rgba(63, 63, 70, 0.2)' },
          horzLines: { color: 'rgba(63, 63, 70, 0.2)' },
        },
        timeScale: {
          timeVisible: true,
          secondsVisible: true,
        },
        leftPriceScale: {
          borderVisible: false,
        },
        rightPriceScale: {
          borderVisible: false,
        },
      })

      const macdSeries = chart.addLineSeries({ color: '#f97316', lineWidth: 1, priceScaleId: 'left' })
      const macdSignalSeries = chart.addLineSeries({ color: '#facc15', lineWidth: 1, priceScaleId: 'left' })
      const rsiSeries = chart.addLineSeries({ color: '#0ea5e9', lineWidth: 1, priceScaleId: 'right' })

      chartRef.current = chart
      seriesRef.current = {
        macd: macdSeries,
        macdSignal: macdSignalSeries,
        rsi: rsiSeries,
      }
    }

    void setup()

    return () => {
      active = false
      chartRef.current?.remove()
      chartRef.current = null
      seriesRef.current = null
    }
  }, [])

  React.useEffect(() => {
    if (!seriesRef.current) return
    seriesRef.current.macd.setData(indicators.macd ? oscillators.macd : [])
    seriesRef.current.macdSignal.setData(indicators.macd ? oscillators.macdSignal : [])
    seriesRef.current.rsi.setData(indicators.rsi ? oscillators.rsi : [])

    const any = indicators.macd ? oscillators.macd.length > 0 : indicators.rsi ? oscillators.rsi.length > 0 : false
    if (any) {
      chartRef.current?.timeScale().fitContent()
    }
  }, [oscillators, indicators])

  return (
    <div ref={containerRef} className="min-h-[14rem] w-full" role="img" aria-label="Indicator chart for MACD and RSI" />
  )
}

const buildCandles = (bars: TorghutBar[]): CandlestickData[] => {
  const points: CandlestickData[] = []
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
  const ema12: LineData[] = []
  const ema26: LineData[] = []
  const bollUpper: LineData[] = []
  const bollMid: LineData[] = []
  const bollLower: LineData[] = []
  const vwapSession: LineData[] = []
  const vwapW5m: LineData[] = []

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
  const macd: LineData[] = []
  const macdSignal: LineData[] = []
  const rsi: LineData[] = []

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

const toTimestamp = (value: string | undefined): UTCTimestamp | null => {
  if (!value) return null
  const parsed = Date.parse(value)
  if (Number.isNaN(parsed)) return null
  return Math.floor(parsed / 1000) as UTCTimestamp
}

const sortByTime = <T extends { time: UTCTimestamp }>(a: T, b: T) => a.time - b.time
