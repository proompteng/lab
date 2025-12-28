export type IndicatorState = {
  ema: boolean
  boll: boolean
  vwap: boolean
  macd: boolean
  rsi: boolean
}

export type RangeOption = {
  id: string
  label: string
  seconds: number
}

export type ResolutionOption = {
  id: string
  label: string
  seconds: number
}

export type TorghutBar = {
  event_ts?: string
  eventTs?: string
  ts?: string
  time?: string
  o?: number
  h?: number
  l?: number
  c?: number
  open?: number
  high?: number
  low?: number
  close?: number
}

export type TorghutSignal = {
  event_ts?: string
  eventTs?: string
  ts?: string
  time?: string
  macd?: {
    macd: number
    signal: number
    hist?: number
  }
  ema?: {
    ema12: number
    ema26: number
  }
  rsi14?: number
  rsi_14?: number
  boll?: {
    mid: number
    upper: number
    lower: number
  }
  vwap?: {
    session: number
    w5m?: number
  }
  vol_realized?: {
    w60s?: number
  }
}
