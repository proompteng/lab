'use client'

import { useEffect, useMemo, useRef, useState } from 'react'
import { cn } from '@/lib/utils'

const COMMAND = 'kubectl get agentruns'
const MIN_VISIBLE_PX = 64

type Segment = {
  text: string
  className?: string
}

type Row = {
  id: string
  segments: Segment[]
}

function usePrefersReducedMotion() {
  const [reduced, setReduced] = useState(false)

  useEffect(() => {
    const media = window.matchMedia('(prefers-reduced-motion: reduce)')
    const update = () => setReduced(media.matches)
    update()
    media.addEventListener('change', update)
    return () => media.removeEventListener('change', update)
  }, [])

  return reduced
}

function formatTime(now: Date) {
  return now.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })
}

function mkRow(id: string, segments: Segment[]): Row {
  return { id, segments }
}

function randomFrom<T>(items: readonly T[]) {
  return items[Math.floor(Math.random() * items.length)]
}

function generateAgentRunName() {
  const nouns = [
    'jangar',
    'torghut',
    'codex',
    'policy',
    'replay',
    'audit',
    'ledger',
    'router',
    'queue',
    'deploy',
  ] as const
  const tails = ['a3f2', '9c1b', '77de', '0b42', 'c8aa', '3f1d', 'e204', '6a9e'] as const
  const noun = randomFrom(nouns)
  const tail = randomFrom(tails)
  return `${noun}-${tail}`
}

function generateLogRow(index: number) {
  const level = index % 19 === 0 ? 'ERROR' : index % 7 === 0 ? 'WARN' : 'INFO'
  const run = `${generateAgentRunName()}-${String(index).padStart(2, '0')}`
  const phase = randomFrom(['Pending', 'Running', 'Succeeded', 'Failed', 'Cancelled'] as const)
  const runtime = randomFrom(['workflow', 'direct'] as const)
  const reasons = [
    'Completed',
    'InvalidSpec',
    'AdmissionDenied',
    'QueueLimit',
    'CancelledByUser',
    'RuntimeError',
  ] as const
  const reason = phase === 'Succeeded' ? 'Completed' : phase === 'Pending' ? 'QueueLimit' : randomFrom(reasons)

  const messages = {
    INFO: [
      `reconciled AgentRun ${run} status.phase=${phase} runtime=${runtime}`,
      `wrote controller ConfigMap label agents.proompteng.ai/agent-run=${run}`,
      `computed additionalPrinterColumns: Phase Agent Succeeded Reason StartTime CompletionTime Runtime`,
      `policy checks completed AgentRun=${run} result=allow`,
      `streaming status events AgentRun=${run} phase=${phase}`,
    ],
    WARN: [
      `backpressure: AgentRun=${run} phase=Pending reason=QueueLimit`,
      `admission policy latency elevated (p95=412ms) AgentRun=${run}`,
      `retrying provider update AgentRun=${run} conditions.Succeeded.reason=${reason}`,
    ],
    ERROR: [
      `admission denied AgentRun=${run} reason=InvalidSpec`,
      `controller error AgentRun=${run} phase=Failed reason=RuntimeError`,
      `actuation blocked AgentRun=${run} phase=Failed reason=AdmissionDenied`,
    ],
  } as const

  return mkRow(`log-${Date.now()}-${index}`, [
    { text: formatTime(new Date()), className: 'text-white/45' },
    { text: '  ' },
    {
      text: level.padEnd(5),
      className: level === 'ERROR' ? 'text-rose-300' : level === 'WARN' ? 'text-amber-200' : 'text-emerald-200',
    },
    { text: '  ' },
    { text: randomFrom(messages[level]), className: 'text-white/80' },
  ])
}

function clamp(value: number, min: number, max: number) {
  return Math.min(Math.max(value, min), max)
}

function pad(text: string, width: number) {
  return text.length >= width ? `${text.slice(0, Math.max(0, width - 1))}\u2026` : text.padEnd(width)
}

function formatKubectlHeader() {
  // Mirrors charts/agents/crds/agents.proompteng.ai_agentruns.yaml additionalPrinterColumns
  const cols = [
    pad('NAME', 38),
    pad('PHASE', 10),
    pad('AGENT', 16),
    pad('SUCCEEDED', 10),
    pad('REASON', 16),
    pad('STARTTIME', 20),
    pad('COMPLETIONTIME', 20),
    pad('RUNTIME', 10),
  ]
  return cols.join(' ')
}

function formatKubectlRow(input: {
  name: string
  phase: string
  agent: string
  succeeded: string
  reason: string
  startTime: string
  completionTime: string
  runtime: string
}) {
  const cols = [
    pad(input.name, 38),
    pad(input.phase, 10),
    pad(input.agent, 16),
    pad(input.succeeded, 10),
    pad(input.reason, 16),
    pad(input.startTime, 20),
    pad(input.completionTime, 20),
    pad(input.runtime, 10),
  ]
  return cols.join(' ')
}

export default function TerminalWindow({ className }: { className?: string }) {
  const reducedMotion = usePrefersReducedMotion()
  const scrollAnchorRef = useRef<HTMLDivElement | null>(null)
  const windowRef = useRef<HTMLDivElement | null>(null)
  const dragRef = useRef<{
    pointerId: number
    startX: number
    startY: number
    startOffsetX: number
    startOffsetY: number
  } | null>(null)
  const [offset, setOffset] = useState({ x: 0, y: 0 })
  const [isDragging, setIsDragging] = useState(false)

  const bootRows = useMemo<Row[]>(
    () => [
      mkRow('boot-0', [
        { text: 'proompteng ', className: 'text-emerald-200' },
        { text: 'agent control plane', className: 'text-white/80' },
      ]),
      mkRow('boot-1', [
        { text: 'connecting ', className: 'text-white/60' },
        { text: 'cluster=agents-prod ', className: 'text-sky-200' },
        { text: '... ok', className: 'text-emerald-200' },
      ]),
      mkRow('boot-2', [
        { text: 'auth ', className: 'text-white/60' },
        { text: 'serviceaccount=landing-ro ', className: 'text-white/80' },
        { text: '... ok', className: 'text-emerald-200' },
      ]),
      mkRow('boot-3', [
        { text: 'tailing ', className: 'text-white/60' },
        { text: 'agents-controller logs', className: 'text-white/80' },
        { text: ' (live)', className: 'text-white/45' },
      ]),
    ],
    [],
  )

  const [commandText, setCommandText] = useState(reducedMotion ? COMMAND : '')
  const [phase, setPhase] = useState<'boot' | 'typing' | 'output'>('boot')
  const [rows, setRows] = useState<Row[]>(() => (reducedMotion ? [generateLogRow(1), generateLogRow(2)] : []))

  const scrollKey = `${phase}:${commandText.length}:${rows.length}`
  useEffect(() => {
    void scrollKey
    if (!scrollAnchorRef.current) return
    scrollAnchorRef.current.scrollIntoView({ block: 'end' })
  }, [scrollKey])

  useEffect(() => {
    if (!isDragging) return

    const onMove = (event: PointerEvent) => {
      if (!dragRef.current) return
      if (event.pointerId !== dragRef.current.pointerId) return
      if (!windowRef.current) return

      const container = windowRef.current.offsetParent
      if (!(container instanceof HTMLElement)) return

      const containerRect = container.getBoundingClientRect()
      const windowRect = windowRef.current.getBoundingClientRect()

      const deltaX = event.clientX - dragRef.current.startX
      const deltaY = event.clientY - dragRef.current.startY
      const nextX = dragRef.current.startOffsetX + deltaX
      const nextY = dragRef.current.startOffsetY + deltaY

      const maxX = containerRect.width / 2 + windowRect.width / 2 - MIN_VISIBLE_PX
      const minX = MIN_VISIBLE_PX - containerRect.width / 2 - windowRect.width / 2
      const maxY = containerRect.height / 2 + windowRect.height / 2 - MIN_VISIBLE_PX
      const minY = MIN_VISIBLE_PX - containerRect.height / 2 - windowRect.height / 2

      setOffset({ x: clamp(nextX, minX, maxX), y: clamp(nextY, minY, maxY) })
    }

    const onUp = (event: PointerEvent) => {
      if (!dragRef.current) return
      if (event.pointerId !== dragRef.current.pointerId) return
      dragRef.current = null
      setIsDragging(false)
    }

    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onUp)
    window.addEventListener('pointercancel', onUp)
    return () => {
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onUp)
      window.removeEventListener('pointercancel', onUp)
    }
  }, [isDragging])

  useEffect(() => {
    if (reducedMotion) {
      setPhase('output')
      setCommandText(COMMAND)
      setRows((prev) => {
        const initial = [
          mkRow('out-header', [{ text: formatKubectlHeader(), className: 'text-white/65' }]),
          mkRow('out-0', [
            {
              text: formatKubectlRow({
                name: 'leader-election-implementation-20260207-run',
                phase: 'Running',
                agent: 'codex-agent',
                succeeded: 'False',
                reason: 'Running',
                startTime: '2026-02-17T01:18:22Z',
                completionTime: '-',
                runtime: 'workflow',
              }),
              className: 'text-white/80',
            },
          ]),
          mkRow('out-1', [
            {
              text: formatKubectlRow({
                name: 'torghut-audit-evidence-20260217-run',
                phase: 'Succeeded',
                agent: 'codex-agent',
                succeeded: 'True',
                reason: 'Completed',
                startTime: '2026-02-17T01:06:02Z',
                completionTime: '2026-02-17T01:10:44Z',
                runtime: 'workflow',
              }),
              className: 'text-white/80',
            },
          ]),
        ]
        return [...initial, ...prev]
      })
      return
    }

    setPhase('boot')
    setCommandText('')
    setRows([])

    const timeouts: number[] = []
    const intervals: number[] = []

    timeouts.push(
      window.setTimeout(() => {
        setPhase('typing')
        let i = 0
        const typingId = window.setInterval(() => {
          i += 1
          setCommandText(COMMAND.slice(0, i))
          if (i < COMMAND.length) return

          window.clearInterval(typingId)
          timeouts.push(
            window.setTimeout(() => {
              setPhase('output')
              setRows([
                mkRow('out-header', [{ text: formatKubectlHeader(), className: 'text-white/65' }]),
                mkRow('out-0', [
                  {
                    text: formatKubectlRow({
                      name: 'leader-election-implementation-20260207-run',
                      phase: 'Running',
                      agent: 'codex-agent',
                      succeeded: 'False',
                      reason: 'Running',
                      startTime: '2026-02-17T01:18:22Z',
                      completionTime: '-',
                      runtime: 'workflow',
                    }),
                    className: 'text-white/80',
                  },
                ]),
                mkRow('out-1', [
                  {
                    text: formatKubectlRow({
                      name: 'control-plane-filters-20260130-run',
                      phase: 'Pending',
                      agent: 'codex-agent',
                      succeeded: 'False',
                      reason: 'QueueLimit',
                      startTime: '2026-02-17T01:19:07Z',
                      completionTime: '-',
                      runtime: 'workflow',
                    }),
                    className: 'text-white/80',
                  },
                ]),
                mkRow('out-2', [
                  {
                    text: formatKubectlRow({
                      name: 'torghut-audit-evidence-20260217-run',
                      phase: 'Succeeded',
                      agent: 'codex-agent',
                      succeeded: 'True',
                      reason: 'Completed',
                      startTime: '2026-02-17T01:06:02Z',
                      completionTime: '2026-02-17T01:10:44Z',
                      runtime: 'workflow',
                    }),
                    className: 'text-white/80',
                  },
                ]),
              ])
            }, 260),
          )
        }, 48)
        intervals.push(typingId)
        timeouts.push(
          window.setTimeout(() => {
            window.clearInterval(typingId)
            setPhase('output')
          }, 10_000),
        )
      }, 650),
    )

    timeouts.push(
      window.setTimeout(() => {
        let idx = 0
        const logId = window.setInterval(() => {
          idx += 1
          setRows((prev) => {
            const next = [...prev, generateLogRow(idx)]
            return next.length > 160 ? next.slice(next.length - 160) : next
          })
        }, 920)
        intervals.push(logId)
        timeouts.push(window.setTimeout(() => window.clearInterval(logId), 60_000))
      }, 1_200),
    )

    return () => {
      for (const t of timeouts) window.clearTimeout(t)
      for (const i of intervals) window.clearInterval(i)
    }
  }, [reducedMotion])

  return (
    <div
      ref={windowRef}
      className={cn(
        'absolute left-1/2 top-1/2 w-full -translate-x-1/2 -translate-y-1/2 select-none rounded-[28px]',
        'border border-white/10 bg-[#0b1020]/55 shadow-[0_40px_120px_-50px_rgba(0,0,0,0.95)] backdrop-blur',
        'font-[family:var(--font-jetbrains-mono)]',
        className,
      )}
      style={{
        transform: `translate(-50%, -50%) translate3d(${offset.x}px, ${offset.y}px, 0)`,
      }}
    >
      <div
        className={cn(
          'flex cursor-grab items-center justify-between gap-4 rounded-t-[28px] border-b border-white/10',
          'bg-[linear-gradient(180deg,rgba(255,255,255,0.07),rgba(255,255,255,0.03))] px-5 py-3',
          isDragging ? 'cursor-grabbing' : undefined,
        )}
        onPointerDown={(event) => {
          if (event.button !== 0) return
          if (!windowRef.current) return
          dragRef.current = {
            pointerId: event.pointerId,
            startX: event.clientX,
            startY: event.clientY,
            startOffsetX: offset.x,
            startOffsetY: offset.y,
          }
          setIsDragging(true)
          ;(event.currentTarget as HTMLDivElement).setPointerCapture(event.pointerId)
          event.preventDefault()
        }}
        style={{ touchAction: 'none' }}
      >
        <div className="flex items-center gap-2.5">
          <span className="h-3.5 w-3.5 rounded-full bg-rose-400/90 shadow-[0_0_0_1px_rgba(0,0,0,0.28)]" />
          <span className="h-3.5 w-3.5 rounded-full bg-amber-300/90 shadow-[0_0_0_1px_rgba(0,0,0,0.28)]" />
          <span className="h-3.5 w-3.5 rounded-full bg-emerald-400/90 shadow-[0_0_0_1px_rgba(0,0,0,0.28)]" />
        </div>
        <div className="min-w-0">
          <p className="truncate text-center text-xs tracking-[0.22em] text-white/70">terminal: agents-prod</p>
        </div>
        <div className="w-10" />
      </div>

      <div className="relative h-[min(72svh,760px)] overflow-hidden rounded-b-[28px]">
        <div className="pointer-events-none absolute inset-0 bg-[radial-gradient(800px_380px_at_16%_8%,rgba(34,197,94,0.10),transparent_60%),radial-gradient(700px_320px_at_90%_14%,rgba(56,189,248,0.08),transparent_60%)]" />
        <div className={cn('relative h-full overflow-auto px-6 py-6 text-[12.5px] leading-relaxed sm:text-[13.5px]')}>
          <div className="space-y-1 whitespace-pre">
            {bootRows.map((row) => (
              <div key={row.id}>
                {row.segments.map((segment, idx) => (
                  <span key={`${row.id}-${idx}`} className={segment.className}>
                    {segment.text}
                  </span>
                ))}
              </div>
            ))}

            <div>
              <span className="text-emerald-200">➜</span>
              <span className="text-white/45"> </span>
              <span className="text-sky-200">agents</span>
              <span className="text-white/45"> </span>
              <span className="text-white/80">{phase === 'boot' ? '' : commandText}</span>
              {phase === 'typing' ? (
                <span className="ml-0.5 inline-block h-4 w-2 translate-y-[2px] bg-white/70" />
              ) : null}
            </div>

            {phase === 'output'
              ? rows.map((row) => (
                  <div key={row.id}>
                    {row.segments.map((segment, idx) => (
                      <span key={`${row.id}-${idx}`} className={segment.className}>
                        {segment.text}
                      </span>
                    ))}
                  </div>
                ))
              : null}
          </div>
          <div ref={scrollAnchorRef} />
        </div>
      </div>
    </div>
  )
}
