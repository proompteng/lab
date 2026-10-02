import { Result } from 'effect'

import { OrderSide } from '../execution/contracts'
import type { JevProtocol } from '../jev/protocol'
import { replayQuoteRejection } from './broker-execution-evidence'
import {
  applyControlOrder,
  ControlPolicy,
  createControlPortfolio,
  triggerControlExit,
  type ControlPortfolio,
  type ControlQuote,
} from './control-portfolio'
import { studyEntryQuantity, type SignalStudyInputSchema } from './signal-study'

export enum MatchedEvent {
  EntryDecision = 'ENTRY_DECISION',
  EntryArrival = 'ENTRY_ARRIVAL',
  Poll = 'POLL',
  ExitArrival = 'EXIT_ARRIVAL',
}

export interface MatchedLifecycle {
  readonly portfolio: ControlPortfolio
  readonly entry:
    | { readonly status: 'PENDING'; readonly quantityMicros: bigint; readonly quote: ControlQuote }
    | { readonly status: 'SKIPPED' }
    | null
  readonly exit: { readonly atMs: number; readonly quote: ControlQuote } | null
  readonly problems: readonly string[]
  readonly quoteHashes: readonly string[]
  readonly orders: readonly {
    readonly atMs: number
    readonly side: OrderSide
    readonly outcome: Result.Result.Success<ReturnType<typeof applyControlOrder>>['outcome']
  }[]
}

export interface MatchedTerms {
  readonly symbol: string
  readonly protocol: JevProtocol
  readonly assumptions: typeof SignalStudyInputSchema.Type.assumptions
  readonly entryBudgetMicros: string
  readonly decidedAtMs: number
  readonly cutoffMs: number
  readonly closeMs: number
}

export const createMatchedLifecycle = (budget: string) =>
  createControlPortfolio(budget).pipe(
    Result.map(
      (portfolio): MatchedLifecycle => ({
        portfolio,
        entry: null,
        exit: null,
        problems: [],
        quoteHashes: [],
        orders: [],
      }),
    ),
  )

export const stepMatchedLifecycle = (
  state: MatchedLifecycle,
  terms: MatchedTerms,
  event: { readonly kind: MatchedEvent; readonly atMs: number; readonly quote: ControlQuote },
) =>
  Result.gen(function* () {
    const { quote, atMs } = event
    const problem = (reason: string): MatchedLifecycle => ({
      ...state,
      problems: [...state.problems, `${atMs}:${reason}`],
    })
    if (atMs >= terms.closeMs) return problem('execution-at-or-after-close')
    if (event.kind === MatchedEvent.EntryDecision) {
      if (atMs !== terms.decidedAtMs || state.entry !== null || state.orders.length !== 0)
        return problem('entry-event-order')
      if (atMs + terms.assumptions.latencyMs >= terms.cutoffMs)
        return { ...state, entry: { status: 'SKIPPED' as const } }
      const rejection = replayQuoteRejection(quote, terms.symbol, atMs, terms.protocol)
      if (rejection !== null || quote === undefined) return problem(rejection ?? 'missing-entry-quote')
      const quantityMicros = yield* studyEntryQuantity({ ...terms, referencePrice: quote.value.askPrice })
      return {
        ...state,
        entry:
          quantityMicros === 0n
            ? { status: 'SKIPPED' as const }
            : { status: 'PENDING' as const, quantityMicros, quote },
        quoteHashes: [...state.quoteHashes, quote.recordHash],
      }
    }
    if (event.kind === MatchedEvent.EntryArrival) {
      if (atMs !== terms.decidedAtMs + terms.assumptions.latencyMs) return problem('entry-arrival-time')
      if (state.entry === null || state.entry.status === 'SKIPPED') return state
      if (state.orders.length !== 0) return problem('duplicate-entry-arrival')
      const result = yield* applyControlOrder(state.portfolio, {
        ...terms,
        side: OrderSide.Buy,
        quantityMicros: state.entry.quantityMicros,
        decisionQuote: state.entry.quote,
        arrivalQuote: quote,
        decisionAtMs: terms.decidedAtMs,
        arrivalAtMs: atMs,
      })
      return {
        ...state,
        portfolio: result.portfolio,
        problems: result.outcome.status === 'UNRESOLVED' ? [...state.problems, result.outcome.reason] : state.problems,
        quoteHashes: quote === undefined ? state.quoteHashes : [...state.quoteHashes, quote.recordHash],
        orders: [...state.orders, { atMs, side: OrderSide.Buy, outcome: result.outcome }],
      }
    }
    if (state.portfolio.inventory.status === 'FLAT') return state
    if (event.kind === MatchedEvent.Poll) {
      if (state.exit !== null) return problem('overlapping-exit-routing')
      const rejection = replayQuoteRejection(quote, terms.symbol, atMs, terms.protocol)
      const portfolio = yield* triggerControlExit({
        portfolio: state.portfolio,
        protocol: terms.protocol,
        policy: ControlPolicy.RelativeMomentum,
        atMs,
        cutoffMs: terms.cutoffMs,
        quote,
      })
      const next = {
        ...state,
        portfolio,
        problems: rejection === null ? state.problems : [...state.problems, `${atMs}:${rejection}`],
        quoteHashes: quote === undefined ? state.quoteHashes : [...state.quoteHashes, quote.recordHash],
      }
      return portfolio.inventory.status === 'EXITING' ? { ...next, exit: { atMs, quote } } : next
    }
    const pending = state.exit
    if (pending === null) return state
    if (atMs !== pending.atMs + terms.assumptions.latencyMs) return problem('exit-arrival-time')
    const position = state.portfolio.ledger.positions[0]
    if (position === undefined) return problem('exit-without-position')
    const result = yield* applyControlOrder(state.portfolio, {
      ...terms,
      side: OrderSide.Sell,
      quantityMicros: BigInt(position.quantityMicros),
      decisionQuote: pending.quote,
      arrivalQuote: quote,
      decisionAtMs: pending.atMs,
      arrivalAtMs: atMs,
    })
    return {
      ...state,
      portfolio: result.portfolio,
      exit: null,
      problems: result.outcome.status === 'UNRESOLVED' ? [...state.problems, result.outcome.reason] : state.problems,
      quoteHashes: quote === undefined ? state.quoteHashes : [...state.quoteHashes, quote.recordHash],
      orders: [...state.orders, { atMs, side: OrderSide.Sell, outcome: result.outcome }],
    }
  })

export const finishMatchedLifecycle = (state: MatchedLifecycle) => ({
  status:
    state.entry === null ||
    (state.entry.status === 'PENDING' && state.orders.length === 0) ||
    state.problems.length > 0 ||
    state.portfolio.ledger.positions.length > 0
      ? ('UNRESOLVED' as const)
      : state.portfolio.ledger.fills.length === 0
        ? ('NO_ENTRY_FILL' as const)
        : ('RESOLVED' as const),
  netExecutionPnlMicros:
    state.entry === null || (state.entry.status === 'PENDING' && state.orders.length === 0) || state.problems.length > 0
      ? null
      : state.portfolio.ledger.netRealizedPnlAfterCostsMicros,
  fills: state.portfolio.ledger.fills,
  episodes: state.portfolio.episodes,
  quoteHashes: state.quoteHashes,
  orders: state.orders,
  problems: state.problems,
})
