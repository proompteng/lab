import { useQuery } from '@tanstack/react-query'
import { createFileRoute } from '@tanstack/react-router'
import {
  Activity,
  AlertTriangle,
  BarChart3,
  CheckCircle2,
  CircleDollarSign,
  Clock,
  Crosshair,
  ListChecks,
  Newspaper,
  ShieldCheck,
  TrendingUp,
  Wallet,
} from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'
import type { ReactNode } from 'react'

import type {
  AutotraderEvent,
  AutotraderOrder,
  AutotraderRiskCheck,
  AutotraderSession,
  AutotraderSessionDetail,
  AutotraderTradeTicket,
} from '~/server/autotrader-schema'

export const Route = createFileRoute('/autotrader')({
  component: AutotraderPage,
})

const cx = (...values: Array<string | false | null | undefined>) => values.filter(Boolean).join(' ')

type SessionsResponse = {
  sessions: AutotraderSession[]
}

async function fetchSessions(): Promise<SessionsResponse> {
  const response = await fetch('/api/autotrader/sessions?limit=30')
  if (!response.ok) throw new Error(`autotrader sessions request failed: ${response.status}`)
  return (await response.json()) as SessionsResponse
}

async function fetchSessionDetail(sessionId: string): Promise<AutotraderSessionDetail> {
  const response = await fetch(`/api/autotrader/sessions/${sessionId}`)
  if (!response.ok) throw new Error(`autotrader session request failed: ${response.status}`)
  return (await response.json()) as AutotraderSessionDetail
}

const formatDate = (value: string | null) => {
  if (!value) return 'open'
  const parsed = new Date(value)
  if (Number.isNaN(parsed.getTime())) return value
  return new Intl.DateTimeFormat(undefined, {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  }).format(parsed)
}

const formatNumber = (value: string | null | undefined) => {
  if (value == null) return 'n/a'
  const parsed = Number(value)
  if (!Number.isFinite(parsed)) return value
  return new Intl.NumberFormat(undefined, { maximumFractionDigits: 2 }).format(parsed)
}

const formatMoney = (value: string | null | undefined) => {
  if (value == null) return 'n/a'
  const parsed = Number(value)
  if (!Number.isFinite(parsed)) return value
  return new Intl.NumberFormat(undefined, { style: 'currency', currency: 'USD', maximumFractionDigits: 2 }).format(
    parsed,
  )
}

function AutotraderPage() {
  const [selectedSessionId, setSelectedSessionId] = useState<string | null>(null)
  const sessions = useQuery({
    queryKey: ['autotrader-sessions'],
    queryFn: fetchSessions,
    refetchInterval: 20_000,
  })
  const activeSessionId = selectedSessionId ?? sessions.data?.sessions[0]?.id ?? null
  const detail = useQuery({
    queryKey: ['autotrader-session', activeSessionId],
    queryFn: () => fetchSessionDetail(activeSessionId ?? ''),
    enabled: Boolean(activeSessionId),
    refetchInterval: 10_000,
  })

  useEffect(() => {
    if (selectedSessionId || !sessions.data?.sessions[0]) return
    setSelectedSessionId(sessions.data.sessions[0].id)
  }, [selectedSessionId, sessions.data?.sessions])

  const selectedSession = useMemo(
    () => sessions.data?.sessions.find((session) => session.id === activeSessionId) ?? null,
    [activeSessionId, sessions.data?.sessions],
  )

  return (
    <main className="grid h-dvh w-full grid-cols-1 overflow-hidden bg-black text-[#e7e9ea] xl:grid-cols-[220px_minmax(0,1fr)]">
      <aside className="hidden min-h-0 justify-end border-r border-[#2f3336] bg-black xl:flex">
        <div className="flex w-[220px] flex-col px-2 py-3">
          <nav className="grid gap-1" aria-label="Synthesis navigation">
            <RailLink href="/" icon={<Newspaper />}>
              Feed
            </RailLink>
            <RailLink href="/autotrader" active icon={<Activity />}>
              Autotrader
            </RailLink>
          </nav>
          <div className="mt-auto px-3 py-4 font-mono text-xs leading-6 text-[#71767b]">synthesis runtime state</div>
        </div>
      </aside>

      <section className="flex min-h-0 min-w-0 flex-col bg-black">
        <header className="shrink-0 border-b border-[#2f3336] bg-black/90 px-4 py-3 backdrop-blur sm:px-5">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="min-w-0">
              <h1 className="text-xl font-semibold tracking-normal">Autotrader</h1>
              <p className="mt-0.5 text-xs text-[#71767b]">
                {selectedSession
                  ? `${selectedSession.tradingDate} / ${selectedSession.agentRunName}`
                  : 'market-session runtime'}
              </p>
            </div>
            <div className="flex items-center gap-2 font-mono text-xs text-[#71767b]">
              <Clock className="size-4" />
              <span>{detail.data?.status?.updatedAt ? formatDate(detail.data.status.updatedAt) : 'waiting'}</span>
            </div>
          </div>
        </header>

        <div className="grid min-h-0 flex-1 grid-cols-1 overflow-hidden xl:grid-cols-[340px_minmax(0,1fr)]">
          <section className="min-h-0 border-b border-[#2f3336] xl:border-b-0 xl:border-r">
            <div className="border-b border-[#2f3336] px-4 py-3 text-sm font-semibold">Sessions</div>
            <div className="max-h-56 overflow-y-auto xl:max-h-none xl:h-[calc(100dvh-106px)]">
              {sessions.isLoading ? (
                <LoadingRows count={6} />
              ) : sessions.error ? (
                <ErrorLine
                  message={sessions.error instanceof Error ? sessions.error.message : 'sessions unavailable'}
                />
              ) : sessions.data?.sessions.length ? (
                sessions.data.sessions.map((session) => (
                  <button
                    key={session.id}
                    type="button"
                    className={cx(
                      'block w-full border-b border-[#2f3336] px-4 py-3 text-left transition-colors hover:bg-[#080808]',
                      activeSessionId === session.id && 'bg-[#0b141a]',
                    )}
                    onClick={() => setSelectedSessionId(session.id)}
                  >
                    <div className="flex items-center justify-between gap-3">
                      <span className="truncate text-sm font-semibold">{session.agentRunName}</span>
                      <span className="shrink-0 rounded-full border border-[#2f3336] px-2 py-0.5 text-[0.625rem] text-[#71767b]">
                        {session.mode}
                      </span>
                    </div>
                    <div className="mt-1 flex items-center justify-between gap-3 font-mono text-xs text-[#71767b]">
                      <span>{session.tradingDate}</span>
                      <span>{formatDate(session.finalizedAt)}</span>
                    </div>
                  </button>
                ))
              ) : (
                <div className="px-4 py-8 text-sm text-[#71767b]">No autotrader sessions recorded.</div>
              )}
            </div>
          </section>

          <section className="min-h-0 overflow-y-auto">
            {detail.isLoading ? (
              <div className="p-4">
                <LoadingRows count={10} />
              </div>
            ) : detail.error ? (
              <ErrorLine message={detail.error instanceof Error ? detail.error.message : 'session unavailable'} />
            ) : detail.data ? (
              <SessionDashboard detail={detail.data} />
            ) : (
              <div className="px-6 py-16 text-sm text-[#71767b]">Select a session.</div>
            )}
          </section>
        </div>
      </section>
    </main>
  )
}

function RailLink({
  href,
  active = false,
  icon,
  children,
}: {
  href: string
  active?: boolean
  icon: ReactNode
  children: ReactNode
}) {
  return (
    <a
      href={href}
      className={cx(
        'flex w-fit items-center gap-4 rounded-full px-4 py-3 text-xl tracking-normal transition-colors hover:bg-[#181818]',
        active ? 'font-bold text-[#e7e9ea]' : 'font-normal text-[#e7e9ea]',
      )}
    >
      <span className="[&>svg]:size-6">{icon}</span>
      <span>{children}</span>
    </a>
  )
}

function SessionDashboard({ detail }: { detail: AutotraderSessionDetail }) {
  return (
    <div className="grid gap-0 xl:grid-cols-[minmax(0,1fr)_380px]">
      <div className="min-w-0">
        <StatusPanel detail={detail} />
        <TicketsPanel tickets={detail.tradeTickets} />
        <OrdersPanel orders={detail.orders} fills={detail.fills} />
        <EventsPanel events={detail.events} />
      </div>
      <div className="min-w-0 border-t border-[#2f3336] xl:border-l xl:border-t-0">
        <RiskPanel riskChecks={detail.riskChecks} />
        <PositionsPanel detail={detail} />
        <ScorecardsPanel detail={detail} />
        <SummaryPanel detail={detail} />
      </div>
    </div>
  )
}

function Panel({ title, icon, children }: { title: string; icon: ReactNode; children: ReactNode }) {
  return (
    <section className="border-b border-[#2f3336]">
      <div className="flex items-center gap-2 border-b border-[#2f3336] px-4 py-3 text-sm font-semibold">
        <span className="[&>svg]:size-4">{icon}</span>
        <span>{title}</span>
      </div>
      <div>{children}</div>
    </section>
  )
}

function StatusPanel({ detail }: { detail: AutotraderSessionDetail }) {
  const status = detail.status
  return (
    <Panel title="Live Status" icon={<Activity />}>
      <div className="grid gap-px bg-[#2f3336] sm:grid-cols-2 2xl:grid-cols-4">
        <Metric label="phase" value={status?.phase ?? 'waiting'} />
        <Metric label="cycle" value={status?.cycle == null ? 'n/a' : String(status.cycle)} />
        <Metric label="equity" value={formatMoney(status?.equity)} />
        <Metric label="goal" value={formatMoney(detail.session.goalEquity)} />
        <Metric label="buying power" value={formatMoney(status?.buyingPower)} />
        <Metric label="daytrade bp" value={formatMoney(status?.daytradeBuyingPower)} />
        <Metric label="realized p/l" value={formatMoney(status?.realizedPnl)} />
        <Metric label="unrealized p/l" value={formatMoney(status?.unrealizedPnl)} />
      </div>
      <div className="px-4 py-3">
        <div className="text-xs font-medium uppercase tracking-normal text-[#71767b]">current action</div>
        <div className="mt-1 text-sm leading-6">{status?.currentAction ?? 'No status written yet.'}</div>
        {status?.blocker ? <div className="mt-2 text-sm leading-6 text-[#ffb86b]">{status.blocker}</div> : null}
      </div>
    </Panel>
  )
}

function TicketsPanel({ tickets }: { tickets: AutotraderTradeTicket[] }) {
  return (
    <Panel title="Trade Tickets" icon={<Crosshair />}>
      {tickets.length ? (
        tickets.map((ticket) => (
          <div key={ticket.id} className="border-b border-[#2f3336] px-4 py-3 last:border-b-0">
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-sm font-semibold">{ticket.symbol}</span>
              <Pill>{ticket.setupGrade}</Pill>
              <Pill>{ticket.status}</Pill>
              <Pill>{ticket.protectionType}</Pill>
            </div>
            <div className="mt-2 grid gap-2 text-xs text-[#71767b] 2xl:grid-cols-3">
              <span>{ticket.setupType}</span>
              <span>R {formatNumber(ticket.expectedR)}</span>
              <span>risk {formatMoney(ticket.riskDollars ?? ticket.maxLossAmount)}</span>
            </div>
            <div className="mt-2 text-sm leading-6 text-[#cfd3d6]">{ticket.thesis}</div>
            {ticket.noTradeReason ? <div className="mt-2 text-sm text-[#ffb86b]">{ticket.noTradeReason}</div> : null}
          </div>
        ))
      ) : (
        <EmptyLine text="No trade tickets recorded." />
      )}
    </Panel>
  )
}

function OrdersPanel({ orders, fills }: { orders: AutotraderOrder[]; fills: AutotraderSessionDetail['fills'] }) {
  return (
    <Panel title="Orders And Fills" icon={<CircleDollarSign />}>
      {orders.length || fills.length ? (
        <>
          {orders.map((order) => (
            <div key={order.clientOrderId} className="border-b border-[#2f3336] px-4 py-3">
              <div className="flex flex-wrap items-center gap-2">
                <span className="font-mono text-sm">{order.clientOrderId}</span>
                <Pill>{order.status}</Pill>
                {order.orderClass ? <Pill>{order.orderClass}</Pill> : null}
              </div>
              <div className="mt-2 grid gap-2 text-xs text-[#71767b] 2xl:grid-cols-4">
                <span>{order.symbol}</span>
                <span>{order.side}</span>
                <span>qty {formatNumber(order.quantity)}</span>
                <span>limit {formatMoney(order.limitPrice)}</span>
                {order.takeProfitLimitPrice ? <span>target {formatMoney(order.takeProfitLimitPrice)}</span> : null}
                {order.stopLossStopPrice ? <span>stop {formatMoney(order.stopLossStopPrice)}</span> : null}
                {order.stopLossLimitPrice ? <span>stop limit {formatMoney(order.stopLossLimitPrice)}</span> : null}
              </div>
              {order.rejectReason ? <div className="mt-2 text-sm text-[#ff7a85]">{order.rejectReason}</div> : null}
            </div>
          ))}
          {fills.map((fill) => (
            <div key={fill.brokerFillId} className="border-b border-[#2f3336] px-4 py-3 last:border-b-0">
              <div className="flex flex-wrap items-center gap-2">
                <CheckCircle2 className="size-4 text-[#3fb950]" />
                <span className="text-sm font-semibold">{fill.symbol}</span>
                <span className="font-mono text-xs text-[#71767b]">{fill.brokerFillId}</span>
              </div>
              <div className="mt-2 grid gap-2 text-xs text-[#71767b] 2xl:grid-cols-4">
                <span>{fill.side}</span>
                <span>qty {formatNumber(fill.quantity)}</span>
                <span>@ {formatMoney(fill.price)}</span>
                <span>{formatDate(fill.filledAt)}</span>
              </div>
            </div>
          ))}
        </>
      ) : (
        <EmptyLine text="No orders or fills recorded." />
      )}
    </Panel>
  )
}

function EventsPanel({ events }: { events: AutotraderEvent[] }) {
  return (
    <Panel title="Event Stream" icon={<ListChecks />}>
      {events.length ? (
        events.map((event) => (
          <div key={`${event.sessionId}:${event.seq}`} className="border-b border-[#2f3336] px-4 py-3 last:border-b-0">
            <div className="flex flex-wrap items-center gap-2">
              <span className="font-mono text-xs text-[#71767b]">#{event.seq}</span>
              <span className="text-sm font-semibold">{event.eventType}</span>
              <Pill>{event.severity}</Pill>
              {event.symbol ? <Pill>{event.symbol}</Pill> : null}
            </div>
            <div className="mt-1 text-xs text-[#71767b]">{formatDate(event.occurredAt)}</div>
          </div>
        ))
      ) : (
        <EmptyLine text="No events recorded." />
      )}
    </Panel>
  )
}

function RiskPanel({ riskChecks }: { riskChecks: AutotraderRiskCheck[] }) {
  return (
    <Panel title="Risk Checks" icon={<ShieldCheck />}>
      {riskChecks.length ? (
        riskChecks.map((riskCheck) => (
          <div key={riskCheck.id} className="border-b border-[#2f3336] px-4 py-3 last:border-b-0">
            <div className="flex flex-wrap items-center gap-2">
              {riskCheck.passed ? (
                <CheckCircle2 className="size-4 text-[#3fb950]" />
              ) : (
                <AlertTriangle className="size-4 text-[#ffb86b]" />
              )}
              <span className="text-sm font-semibold">{riskCheck.checkType}</span>
              <Pill>{riskCheck.passed ? 'passed' : 'blocked'}</Pill>
            </div>
            {riskCheck.reason ? <div className="mt-2 text-sm leading-6 text-[#cfd3d6]">{riskCheck.reason}</div> : null}
          </div>
        ))
      ) : (
        <EmptyLine text="No risk checks recorded." />
      )}
    </Panel>
  )
}

function PositionsPanel({ detail }: { detail: AutotraderSessionDetail }) {
  const latestBySymbol = new Map<string, AutotraderSessionDetail['positionSnapshots'][number]>()
  for (const snapshot of detail.positionSnapshots) {
    if (!latestBySymbol.has(snapshot.symbol)) latestBySymbol.set(snapshot.symbol, snapshot)
  }
  const snapshots = [...latestBySymbol.values()]

  return (
    <Panel title="Positions" icon={<Wallet />}>
      {snapshots.length ? (
        snapshots.map((snapshot) => (
          <div key={snapshot.id} className="border-b border-[#2f3336] px-4 py-3 last:border-b-0">
            <div className="flex items-center justify-between gap-3">
              <span className="text-sm font-semibold">{snapshot.symbol}</span>
              <span className="font-mono text-xs text-[#71767b]">{formatDate(snapshot.capturedAt)}</span>
            </div>
            <div className="mt-2 grid grid-cols-2 gap-2 text-xs text-[#71767b]">
              <span>qty {formatNumber(snapshot.quantity)}</span>
              <span>value {formatMoney(snapshot.marketValue)}</span>
              <span>avg {formatMoney(snapshot.averageEntryPrice)}</span>
              <span>p/l {formatMoney(snapshot.unrealizedPnl)}</span>
            </div>
          </div>
        ))
      ) : (
        <EmptyLine text="No position snapshots recorded." />
      )}
    </Panel>
  )
}

function ScorecardsPanel({ detail }: { detail: AutotraderSessionDetail }) {
  const examplesByScorecard = new Map<string, AutotraderSessionDetail['setupExamples']>()
  for (const example of detail.setupExamples) {
    const existing = examplesByScorecard.get(example.scorecardKey) ?? []
    existing.push(example)
    examplesByScorecard.set(example.scorecardKey, existing)
  }

  return (
    <Panel title="Scorecards" icon={<BarChart3 />}>
      {detail.scorecards.length ? (
        detail.scorecards.map((scorecard) => {
          const examples = examplesByScorecard.get(scorecard.key)?.slice(0, 3) ?? []

          return (
            <div key={scorecard.key} className="border-b border-[#2f3336] px-4 py-3 last:border-b-0">
              <div className="flex flex-wrap items-center gap-2">
                <TrendingUp className="size-4 text-[#1d9bf0]" />
                <span className="text-sm font-semibold">{scorecard.symbol ?? 'ALL'}</span>
                <Pill>{scorecard.setupGrade}</Pill>
                <Pill>{scorecard.timeBucket}</Pill>
              </div>
              <div className="mt-2 text-xs text-[#71767b]">{scorecard.setupType}</div>
              <div className="mt-2 grid grid-cols-2 gap-2 text-xs text-[#71767b]">
                <span>n {scorecard.sampleSize}</span>
                <span>avg R {formatNumber(scorecard.avgRealizedR)}</span>
                <span>wins {scorecard.wins}</span>
                <span>losses {scorecard.losses}</span>
              </div>
              {examples.length ? (
                <div className="mt-3 border-t border-[#2f3336] pt-3">
                  <div className="text-[0.625rem] font-medium uppercase tracking-normal text-[#71767b]">
                    recent examples
                  </div>
                  <div className="mt-2 grid gap-2">
                    {examples.map((example) => (
                      <div key={example.id} className="text-xs leading-5 text-[#cfd3d6]">
                        <div className="flex flex-wrap items-center gap-2 text-[#71767b]">
                          <Pill>{example.outcome}</Pill>
                          <span>R {formatNumber(example.realizedR)}</span>
                          <span>{formatDate(example.createdAt)}</span>
                        </div>
                        {example.notes ? <div className="mt-1">{example.notes}</div> : null}
                        {example.mistakeTags.length ? (
                          <div className="mt-1 flex flex-wrap gap-1">
                            {example.mistakeTags.map((tag) => (
                              <span key={tag} className="font-mono text-[0.625rem] text-[#71767b]">
                                #{tag}
                              </span>
                            ))}
                          </div>
                        ) : null}
                      </div>
                    ))}
                  </div>
                </div>
              ) : null}
            </div>
          )
        })
      ) : (
        <EmptyLine text="No scorecards linked to this session." />
      )}
    </Panel>
  )
}

function SummaryPanel({ detail }: { detail: AutotraderSessionDetail }) {
  return (
    <Panel title="Session Summary" icon={<Activity />}>
      <div className="grid gap-px bg-[#2f3336]">
        <Metric label="started" value={formatDate(detail.session.startedAt)} />
        <Metric label="finalized" value={formatDate(detail.session.finalizedAt)} />
        <Metric label="terminal" value={detail.session.terminalReason ?? 'running'} />
      </div>
      <pre className="max-h-72 overflow-auto px-4 py-3 font-mono text-xs leading-5 text-[#cfd3d6]">
        {JSON.stringify(detail.session.summary, null, 2)}
      </pre>
    </Panel>
  )
}

function Metric({ label, value }: { label: string; value: string }) {
  return (
    <div className="bg-black px-4 py-3">
      <div className="text-[0.625rem] font-medium uppercase tracking-normal text-[#71767b]">{label}</div>
      <div className="mt-1 truncate font-mono text-sm text-[#e7e9ea]">{value}</div>
    </div>
  )
}

function Pill({ children }: { children: ReactNode }) {
  return (
    <span className="inline-flex h-5 items-center rounded-full border border-[#2f3336] px-2 text-[0.625rem] font-medium text-[#cfd3d6]">
      {children}
    </span>
  )
}

function EmptyLine({ text }: { text: string }) {
  return <div className="px-4 py-5 text-sm text-[#71767b]">{text}</div>
}

function ErrorLine({ message }: { message: string }) {
  return <div className="border-b border-[#2f3336] px-4 py-5 text-sm text-[#ff7a85]">{message}</div>
}

function LoadingRows({ count }: { count: number }) {
  return (
    <div>
      {Array.from({ length: count }, (_, index) => (
        <div key={index} className="border-b border-[#2f3336] px-4 py-4">
          <div className="h-3 w-2/3 rounded bg-[#202327]" />
          <div className="mt-3 h-3 w-1/3 rounded bg-[#16181c]" />
        </div>
      ))}
    </div>
  )
}
