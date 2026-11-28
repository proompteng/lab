import { expect, test } from 'bun:test'
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { Result } from 'effect'

import { OrderSide, OrderStatus, OrderType } from '../src/execution/contracts'
import {
  Account,
  ErrorCode,
  FindingCode,
  Format,
  Severity,
  renderDivergence,
  verifyDivergence,
} from './verify-multi-account-divergence-core'

const date = '2026-11-27'
const nextDate = '2026-11-30'
const hash = (n: number) => n.toString(16).padStart(64, '0')
const quantity = (shares: number) => (BigInt(shares) * 1_000_000_000n).toString()
const micros = (dollars: number) => (BigInt(dollars) * 1_000_000n).toString()
const fill = (at: string, key: number, shares: number, feeMicros: number) => ({
  executionHash: hash(key),
  at,
  quantityAtoms: quantity(shares),
  priceAtoms: '100000000000',
  feeMicros: String(feeMicros),
})

const session = (day: string, identity: number, equity: number) => {
  const at = `${day}T14:31:00.000Z`
  const shares = equity / 1_000
  return {
    date: day,
    openAt: `${day}T14:30:00.000Z`,
    closeAt: `${day}T${day === date ? '18' : '21'}:00:00.000Z`,
    asOf: `${day}T23:00:00.000Z`,
    complete: true,
    openingEquityMicros: micros(equity),
    pdtDayTrades: 1,
    unattributedFeeMicros: '0',
    signals: [{ slot: 7, symbol: 'QQQ', side: OrderSide.Buy, at }],
    orders: [
      {
        slot: 4,
        symbol: 'QQQ',
        side: OrderSide.Buy,
        type: OrderType.Market,
        status: OrderStatus.Filled,
        quantityAtoms: quantity(shares),
        referenceMicros: micros(100),
        limitMicros: null as string | null,
        stopMicros: null as string | null,
        fills: [fill(at, identity, shares, shares * 10_000)],
      },
    ],
  }
}

const fixture = () => ({
  schemaVersion: 'bayn.multi-account-divergence-evidence.v1',
  sessionDates: [date],
  allowedSymbols: ['QQQ', 'SMH'],
  accounts: {
    [Account.LiveMain]: { identityHash: hash(1), sessions: [session(date, 10, 100_000)] },
    [Account.PaperMain]: { identityHash: hash(2), sessions: [session(date, 20, 50_000)] },
    [Account.PaperSmall]: { identityHash: hash(3), sessions: [session(date, 30, 10_000)] },
  },
})
type Fixture = ReturnType<typeof fixture>
const report = (input: unknown) => Result.getOrThrow(verifyDivergence(input))
const paperMain = (input: unknown) => report(input).sessions[0].comparisons[0]
const paperSmall = (input: unknown) => report(input).sessions[0].comparisons[1]

test('normalizes different account sizes and fill fragments without comparing broker IDs or fill counts', () => {
  const input = fixture()
  const order = input.accounts[Account.PaperMain].sessions[0].orders[0]
  const at = order.fills[0].at
  order.fills = [
    { ...fill(at, 21, 20, 200_000), priceAtoms: '99970000000' },
    { ...fill(at, 22, 30, 300_000), priceAtoms: '100020000000' },
  ]
  const result = report(input)
  expect(result.severity).toBe(Severity.Pass)
  expect(result.sessions[0].comparisons.map(({ shadow }) => shadow)).toEqual([Account.PaperMain, Account.PaperSmall])
  expect(paperMain(input).metrics).toMatchObject({
    signals: { live: 1, paper: 1, matched: 1, maxAbsDeltaMs: 0 },
    orders: { live: 1, paper: 1, comparable: 1 },
    fills: { live: 1, paper: 2, comparableFilledOrders: 1 },
    pdt: { live: 1, paper: 1, delta: 0 },
    feeBps: { live: 1, paper: 1, delta: 0 },
    byOrder: [
      {
        slot: 4,
        orderWeightBps: { live: 1_000, paper: 1_000, delta: 0 },
        fillWeightBps: { live: 1_000, paper: 1_000, delta: 0 },
        filledFractionBps: { live: 10_000, paper: 10_000, delta: 0 },
        slippageBps: { live: 0, paper: 0, delta: 0 },
        feeBps: { live: 1, paper: 1, delta: 0 },
      },
    ],
  })
})

test('JSON and Markdown are stable over source ordering and sort sessions and slots', () => {
  const input = fixture()
  input.sessionDates.push(nextDate)
  for (const [i, account] of Object.values(input.accounts).entries()) {
    account.sessions.push(session(nextDate, 100 + i, [100_000, 50_000, 10_000][i]))
    for (const [j, snapshot] of account.sessions.entries()) {
      const source = snapshot.orders[0]
      snapshot.orders.push({
        ...source,
        slot: 1,
        fills: [{ ...source.fills[0], executionHash: hash(200 + 10 * i + j) }],
      })
      snapshot.signals.push({ ...snapshot.signals[0], slot: 1 })
    }
  }
  const sorted = report(input)
  input.sessionDates.reverse()
  input.allowedSymbols.reverse()
  for (const account of Object.values(input.accounts)) {
    account.sessions.reverse()
    for (const snapshot of account.sessions) {
      snapshot.signals.reverse()
      snapshot.orders.reverse()
    }
  }
  const reordered = report(input)
  for (const format of [Format.Json, Format.Markdown]) {
    expect(renderDivergence(reordered, format)).toBe(renderDivergence(sorted, format))
  }
  expect(sorted.sessions.map((row) => row.date)).toEqual([date, nextDate])
  expect(sorted.sessions[0].comparisons[0].metrics?.byOrder.map(({ slot }) => slot)).toEqual([1, 4])
  expect(renderDivergence(sorted, Format.Markdown)).toContain('| 4 | 1000 / 1000 / 0 |')
})

test('flags missing, unexpected, or changed decisions by slot and never echoes unauthorized labels', () => {
  const input = fixture()
  const small = input.accounts[Account.PaperSmall].sessions[0]
  const signal = small.signals[0]
  small.signals = [
    { ...signal, slot: 8 },
    { ...signal, side: OrderSide.Sell },
  ]
  input.accounts[Account.LiveMain].sessions[0].signals.push({ ...signal, slot: 9 })
  small.orders[0].symbol = 'PRIVATE1'
  const result = report(input)
  expect(result.severity).toBe(Severity.Fail)
  expect(paperSmall(input).findings).toEqual(
    expect.arrayContaining([
      { code: FindingCode.SignalMismatch, severity: Severity.Fail, signalSlot: 7 },
      { code: FindingCode.MissingSignal, severity: Severity.Fail, signalSlot: 8, account: Account.LiveMain },
      { code: FindingCode.MissingSignal, severity: Severity.Fail, signalSlot: 9, account: Account.PaperSmall },
      { code: FindingCode.UnauthorizedSymbol, severity: Severity.Fail, orderSlot: 4, account: Account.PaperSmall },
    ]),
  )
  for (const format of [Format.Json, Format.Markdown])
    expect(renderDivergence(result, format)).not.toContain('PRIVATE1')
})

test('a symbol outside the reviewed allowlist fails even when every account uses it', () => {
  const input = fixture()
  input.allowedSymbols = ['SMH']
  expect(paperMain(input).findings.filter(({ code }) => code === FindingCode.UnauthorizedSymbol)).toHaveLength(4)
  expect(report(input).severity).toBe(Severity.Fail)
})

test('accepts the exact signal timing limit but flags a one-nanosecond breach in either direction', () => {
  const input = { ...fixture(), thresholds: { maxSignalDelayMs: 5 } }
  const mainSignal = input.accounts[Account.PaperMain].sessions[0].signals[0]
  const smallSignal = input.accounts[Account.PaperSmall].sessions[0].signals[0]
  mainSignal.at = `${date}T14:31:00.005000000Z`
  smallSignal.at = `${date}T14:30:59.995Z`
  expect(report(input).severity).toBe(Severity.Pass)
  mainSignal.at = `${date}T14:31:00.005000001Z`
  smallSignal.at = `${date}T14:30:59.994999999Z`
  expect(paperMain(input).findings).toContainEqual({
    code: FindingCode.SignalTiming,
    severity: Severity.Fail,
    signalSlot: 7,
    deltaMs: 5.000001,
  })
  expect(paperSmall(input).findings).toContainEqual({
    code: FindingCode.SignalTiming,
    severity: Severity.Fail,
    signalSlot: 7,
    deltaMs: -5.000001,
  })
})

test('detects absent orders, unfilled counterparts, and unequal partial fill fractions', () => {
  const input = fixture()
  const main = input.accounts[Account.PaperMain].sessions[0]
  const small = input.accounts[Account.PaperSmall].sessions[0]
  const live = input.accounts[Account.LiveMain].sessions[0]
  main.orders = []
  small.orders[0].status = OrderStatus.Canceled
  small.orders[0].fills = []
  expect(paperMain(input).findings).toContainEqual({
    code: FindingCode.MissingOrder,
    severity: Severity.Fail,
    account: Account.PaperMain,
    orderSlot: 4,
  })
  expect(paperSmall(input).findings.map(({ code }) => code)).toContain(FindingCode.MissingFill)
  expect(paperSmall(input).findings.map(({ code }) => code)).toContain(FindingCode.OrderStatus)
  expect(paperSmall(input).metrics?.byOrder[0].slippageBps).toBeNull()

  for (const [snapshot, shares] of [
    [live, 50],
    [small, 4],
  ] as const) {
    const order = snapshot.orders[0]
    order.status = OrderStatus.PartiallyFilled
    order.fills = [fill(`${date}T14:31:00.000Z`, 50, shares, shares * 10_000)]
  }
  expect(paperSmall(input).findings).toContainEqual({
    code: FindingCode.FillFraction,
    severity: Severity.Fail,
    orderSlot: 4,
  })
  expect(paperSmall(input).metrics?.byOrder[0].filledFractionBps).toEqual({ live: 5_000, paper: 4_000, delta: -1_000 })
})

test('treats different order terms and reference prices as failures, not comparable slippage', () => {
  const input = fixture()
  const main = input.accounts[Account.PaperMain].sessions[0].orders[0]
  main.type = OrderType.Limit
  main.limitMicros = micros(100)
  input.accounts[Account.PaperSmall].sessions[0].orders[0].referenceMicros = micros(101)
  expect(paperMain(input).findings).toContainEqual({
    code: FindingCode.OrderTerms,
    severity: Severity.Fail,
    orderSlot: 4,
  })
  expect(paperSmall(input).findings).toContainEqual({
    code: FindingCode.OrderReference,
    severity: Severity.Fail,
    orderSlot: 4,
  })
  expect(paperSmall(input).metrics?.byOrder[0].slippageBps).toBeNull()
})

test('uses adverse signed slippage on sells and buys and checks exact deltas before rounding', () => {
  const input = fixture()
  for (const account of Object.values(input.accounts)) account.sessions[0].orders[0].side = OrderSide.Sell
  const sale = input.accounts[Account.PaperSmall].sessions[0].orders[0].fills[0]
  sale.priceAtoms = '99975000000'
  expect(paperSmall(input).metrics?.byOrder[0].slippageBps).toEqual({ live: 0, paper: 2.5, delta: 2.5 })
  expect(report(input).severity).toBe(Severity.Pass)
  sale.priceAtoms = '99974999999'
  expect(paperSmall(input).findings).toContainEqual({
    code: FindingCode.Slippage,
    severity: Severity.Fail,
    orderSlot: 4,
  })
  sale.priceAtoms = '100026000000'
  expect(paperSmall(input).metrics?.byOrder[0].slippageBps).toEqual({ live: 0, paper: -2.6, delta: -2.6 })
  expect(paperSmall(input).severity).toBe(Severity.Fail)
  for (const account of Object.values(input.accounts)) account.sessions[0].orders[0].side = OrderSide.Buy
  expect(paperSmall(input).metrics?.byOrder[0].slippageBps?.delta).toBe(2.6)
  expect(report({ ...input, thresholds: { maxSlippageDeltaBps: 2.6 } }).severity).toBe(Severity.Pass)
})

test('reports weight, session fee, and PDT deltas with independent configurable limits', () => {
  const input = fixture()
  const shadow = input.accounts[Account.PaperSmall].sessions[0]
  const order = shadow.orders[0]
  order.quantityAtoms = quantity(11)
  order.fills[0] = fill(order.fills[0].at, 30, 11, 110_000)
  shadow.pdtDayTrades = 2
  shadow.unattributedFeeMicros = '220000'
  const pair = paperSmall(input)
  expect(pair.findings.map(({ code }) => code)).toEqual([
    FindingCode.OrderWeight,
    FindingCode.FillWeight,
    FindingCode.Fee,
    FindingCode.Pdt,
  ])
  expect(pair.metrics?.byOrder[0].orderWeightBps).toEqual({ live: 1_000, paper: 1_100, delta: 100 })
  expect(pair.metrics?.feeBps).toEqual({ live: 1, paper: 3, delta: 2 })
  expect(pair.metrics?.pdt).toEqual({ live: 1, paper: 2, delta: 1 })
  expect(
    report({ ...input, thresholds: { maxWeightDeltaBps: 100, maxFeeDeltaBps: 2, maxPdtCountDelta: 1 } }).severity,
  ).toBe(Severity.Pass)
})

test('fees cannot be averaged out across orders or claimed against zero fills', () => {
  const input = fixture()
  for (const [
    i,
    {
      sessions: [snapshot],
    },
  ] of Object.values(input.accounts).entries()) {
    const order = snapshot.orders[0]
    snapshot.orders.push({ ...order, slot: 5, fills: [{ ...order.fills[0], executionHash: hash(100 + i) }] })
  }
  const small = input.accounts[Account.PaperSmall].sessions[0]
  small.orders[0].fills[0].feeMicros = '0'
  small.orders[1].fills[0].feeMicros = '200000'
  const pair = paperSmall({ ...input, thresholds: { maxFeeDeltaBps: 0.5 } })
  expect(pair.metrics?.feeBps?.delta).toBe(0)
  expect(pair.findings).toEqual([
    { code: FindingCode.Fee, severity: Severity.Fail, orderSlot: 4 },
    { code: FindingCode.Fee, severity: Severity.Fail, orderSlot: 5 },
  ])
  small.orders = []
  small.unattributedFeeMicros = '1'
  expect(paperSmall(input).findings).toContainEqual({
    code: FindingCode.FeeWithoutFills,
    severity: Severity.Fail,
    account: Account.PaperSmall,
  })
})

test('never compares missing, incomplete, or different cuts; a date absent from all three still fails', () => {
  const input = fixture()
  input.sessionDates.push(nextDate)
  input.accounts[Account.PaperMain].sessions[0].asOf = `${date}T22:00:00.000Z`
  input.accounts[Account.PaperSmall].sessions[0].complete = false
  const result = report(input)
  expect(result.severity).toBe(Severity.Fail)
  expect(result.sessions[0].comparisons.map(({ findings, metrics }) => [findings[0].code, metrics])).toEqual([
    [FindingCode.MisalignedSession, null],
    [FindingCode.IncompleteSession, null],
  ])
  expect(
    result.sessions[1].comparisons.map(({ findings, metrics }) => [findings.map(({ code }) => code), metrics]),
  ).toEqual([
    [[FindingCode.MissingSession, FindingCode.MissingSession], null],
    [[FindingCode.MissingSession, FindingCode.MissingSession], null],
  ])
})

const idleFixture = () => {
  const input = fixture()
  for (const account of Object.values(input.accounts)) {
    account.sessions[0].signals = []
    account.sessions[0].orders = []
    account.sessions[0].pdtDayTrades = 0
  }
  return input
}

test('empty but complete cuts warn instead of passing or fabricating execution rates', () => {
  const input = idleFixture()
  expect(report(input).severity).toBe(Severity.Warn)
  expect(paperMain(input).findings.map(({ code }) => code)).toEqual([FindingCode.NoSignals, FindingCode.NoFills])
  expect(paperMain(input).metrics?.feeBps).toBeNull()
})

test('rejects contradictory or duplicated evidence before analysis', () => {
  const changes: readonly ((input: Fixture) => void)[] = [
    ({ accounts }) => {
      accounts[Account.PaperSmall].identityHash = accounts[Account.LiveMain].identityHash
    },
    ({ accounts }) => {
      accounts[Account.LiveMain].sessions.push(accounts[Account.LiveMain].sessions[0])
    },
    ({ accounts }) => {
      const { signals } = accounts[Account.LiveMain].sessions[0]
      signals.push(signals[0])
    },
    ({ accounts }) => {
      const { orders } = accounts[Account.LiveMain].sessions[0]
      orders.push(orders[0])
    },
    ({ accounts }) => {
      const order = accounts[Account.PaperMain].sessions[0].orders[0]
      order.fills = [
        { ...order.fills[0], quantityAtoms: quantity(25) },
        { ...order.fills[0], quantityAtoms: quantity(25) },
      ]
    },
    ({ accounts }) => {
      accounts[Account.PaperMain].sessions[0].orders[0].fills = []
    },
    ({ accounts }) => {
      accounts[Account.PaperSmall].sessions[0].orders[0].fills[0].at = `${nextDate}T14:31:00Z`
    },
    ({ accounts }) => {
      accounts[Account.LiveMain].sessions[0].asOf = `${date}T15:00:00.000Z`
    },
    ({ accounts }) => {
      accounts[Account.LiveMain].sessions[0].openingEquityMicros = '0'
    },
    ({ sessionDates }) => {
      sessionDates[0] = nextDate
    },
  ]
  for (const change of changes) {
    const input = fixture()
    change(input)
    expect(Result.isFailure(verifyDivergence(input))).toBe(true)
  }
  for (const maxSlippageDeltaBps of [-1, Infinity, 2.5001, 10_001]) {
    expect(Result.isFailure(verifyDivergence({ ...fixture(), thresholds: { maxSlippageDeltaBps } }))).toBe(true)
  }
  const input = fixture()
  expect(Result.isFailure(verifyDivergence({ ...input, sessionDates: [] }))).toBe(true)
  expect(
    Result.isFailure(verifyDivergence({ ...input, accounts: { ...input.accounts, [Account.PaperSmall]: undefined } })),
  ).toBe(true)
})

test('CLI outputs deterministic reports, fails closed on WARN and FAIL, and redacts every error boundary', () => {
  const secret = 'SYNTHETIC_SECRET_VALUE'
  const dir = mkdtempSync(join(tmpdir(), 'bayn-divergence-'))
  try {
    const path = join(dir, `${secret}.json`)
    const cli = join(import.meta.dir, 'verify-multi-account-divergence.ts')
    const run = (...args: string[]) => Bun.spawnSync([process.execPath, cli, ...args], { env: {} })
    const read = () => run('--fixture', path, '--format', 'json')
    const input = fixture()
    const original = JSON.stringify(input)
    writeFileSync(path, original)
    const success = read()
    expect(success.exitCode).toBe(0)
    expect(success.stdout.toString()).toBe(`${renderDivergence(report(input), Format.Json)}\n`)
    expect(success.stderr.toString()).toBe('')
    expect(success.stdout.toString()).not.toContain(input.accounts[Account.LiveMain].identityHash)
    const markdown = run('--fixture', path)
    expect(markdown.exitCode).toBe(0)
    expect(markdown.stdout.toString()).toBe(`${renderDivergence(report(input), Format.Markdown)}\n`)
    expect(readFileSync(path, 'utf8')).toBe(original)
    expect(readdirSync(dir)).toEqual([`${secret}.json`])

    const fail = fixture()
    fail.accounts[Account.PaperMain].sessions[0].signals = []
    for (const [value, severity] of [
      [idleFixture(), Severity.Warn],
      [fail, Severity.Fail],
    ] as const) {
      writeFileSync(path, JSON.stringify(value))
      const rejected = read()
      expect(rejected.exitCode).not.toBe(0)
      expect(rejected.stdout.toString()).toBe(`${renderDivergence(report(value), Format.Json)}\n`)
      expect(rejected.stdout.toString()).toContain(`"severity": "${severity}"`)
      expect(rejected.stderr.toString()).toBe('')
    }

    writeFileSync(path, `{"${secret}":`)
    const badJson = read()
    const malformed = fixture()
    const snapshot = malformed.accounts[Account.PaperSmall].sessions[0]
    Object.assign(snapshot.orders[0].fills[0], { [secret]: secret })
    writeFileSync(path, JSON.stringify(malformed))
    const badSchema = read()
    writeFileSync(path, JSON.stringify({ ...fixture(), schemaVersion: secret }))
    const badValue = read()
    rmSync(path)
    for (const [result, code] of [
      [badJson, ErrorCode.Json],
      [badSchema, ErrorCode.Evidence],
      [badValue, ErrorCode.Evidence],
      [read(), ErrorCode.Read],
      [run('--fixture', dir), ErrorCode.Read],
      [run('--fixture', path, '--format', secret), ErrorCode.Arguments],
      [run('--fixture', path, '--fixture', path), ErrorCode.Arguments],
      [run(`--${secret}`), ErrorCode.Arguments],
      [run(), ErrorCode.Arguments],
    ] as const) {
      expect(result.exitCode).not.toBe(0)
      expect(result.stdout.toString()).toBe('')
      expect(result.stderr.toString()).toContain(`"severity":"FAIL","code":"${code}"`)
      expect(result.stderr.toString()).not.toContain(secret)
      expect(result.stderr.toString()).not.toContain(dir)
    }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
