'use client'

import { useEffect, useMemo, useRef, useState } from 'react'
import { cn } from '@/lib/utils'

const COMMAND = 'kubectl get agentruns'

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
    'atlas',
    'polaris',
    'kestrel',
    'phoenix',
    'prism',
    'harbor',
    'relay',
    'citadel',
    'delta',
    'lyra',
  ] as const
  const tails = ['a3f2', '9c1b', '77de', '0b42', 'c8aa', '3f1d', 'e204', '6a9e'] as const
  const noun = randomFrom(nouns)
  const tail = randomFrom(tails)
  return `${noun}-${tail}`
}

function generateLogRow(index: number) {
  const level = index % 17 === 0 ? 'ERROR' : index % 7 === 0 ? 'WARN' : 'INFO'
  const run = generateAgentRunName()
  const phase =
    level === 'ERROR'
      ? 'Failed'
      : level === 'WARN'
        ? randomFrom(['Pending', 'Running'] as const)
        : randomFrom(['Running', 'Succeeded'] as const)
  const messages = {
    INFO: [
      `reconciled agentrun/${run} phase=${phase}`,
      `queued agentrun/${run} for policy checks`,
      `persisted trace for agentrun/${run}`,
      `updated routing table (models=17, policies=6)`,
    ],
    WARN: [
      `policy check latency elevated (p95=412ms)`,
      `retrying webhook for agentrun/${run}`,
      `backpressure: agentrun/${run} waiting for capacity`,
    ],
    ERROR: [
      `policy violation: agentrun/${run} blocked by deny rule`,
      `execution failed: agentrun/${run} missing required secret`,
      `controller error: agentrun/${run} exceeded ttl`,
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

export default function TerminalWindow({ className }: { className?: string }) {
  const reducedMotion = usePrefersReducedMotion()
  const scrollAnchorRef = useRef<HTMLDivElement | null>(null)

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
        { text: 'controller logs', className: 'text-white/80' },
        { text: ' (live)', className: 'text-white/45' },
      ]),
    ],
    [],
  )

  const [commandText, setCommandText] = useState(reducedMotion ? COMMAND : '')
  const [phase, setPhase] = useState<'boot' | 'typing' | 'output'>('boot')
  const [rows, setRows] = useState<Row[]>(() => (reducedMotion ? [generateLogRow(1), generateLogRow(2)] : []))

  useEffect(() => {
    void commandText
    void phase
    void rows
    if (!scrollAnchorRef.current) return
    scrollAnchorRef.current.scrollIntoView({ block: 'end' })
  }, [commandText, phase, rows])

  useEffect(() => {
    if (reducedMotion) {
      setPhase('output')
      setCommandText(COMMAND)
      setRows((prev) => {
        const initial = [
          mkRow('out-header', [
            { text: 'NAME', className: 'text-white/70' },
            { text: '                         ' },
            { text: 'PHASE', className: 'text-white/70' },
            { text: '       ' },
            { text: 'AGE', className: 'text-white/70' },
          ]),
          mkRow('out-0', [
            { text: `agentrun/${generateAgentRunName()}`.padEnd(34), className: 'text-white/80' },
            { text: 'Running'.padEnd(11), className: 'text-emerald-200' },
            { text: '2m', className: 'text-white/60' },
          ]),
          mkRow('out-1', [
            { text: `agentrun/${generateAgentRunName()}`.padEnd(34), className: 'text-white/80' },
            { text: 'Succeeded'.padEnd(11), className: 'text-sky-200' },
            { text: '9m', className: 'text-white/60' },
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
                mkRow('out-header', [
                  { text: 'NAME', className: 'text-white/70' },
                  { text: '                         ' },
                  { text: 'PHASE', className: 'text-white/70' },
                  { text: '       ' },
                  { text: 'AGE', className: 'text-white/70' },
                ]),
                mkRow('out-0', [
                  { text: `agentrun/${generateAgentRunName()}`.padEnd(34), className: 'text-white/80' },
                  { text: 'Running'.padEnd(11), className: 'text-emerald-200' },
                  { text: '13s', className: 'text-white/60' },
                ]),
                mkRow('out-1', [
                  { text: `agentrun/${generateAgentRunName()}`.padEnd(34), className: 'text-white/80' },
                  { text: 'Pending'.padEnd(11), className: 'text-amber-200' },
                  { text: '29s', className: 'text-white/60' },
                ]),
                mkRow('out-2', [
                  { text: `agentrun/${generateAgentRunName()}`.padEnd(34), className: 'text-white/80' },
                  { text: 'Succeeded'.padEnd(11), className: 'text-sky-200' },
                  { text: '4m', className: 'text-white/60' },
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
      className={cn(
        'relative rounded-3xl border border-white/10 bg-black/35 shadow-[0_40px_120px_-50px_rgba(0,0,0,0.95)] backdrop-blur',
        className,
      )}
    >
      <div className="flex items-center justify-between gap-4 rounded-t-3xl border-b border-white/10 bg-white/5 px-5 py-4">
        <div className="flex items-center gap-2">
          <span className="size-2 rounded-full bg-rose-400/80" />
          <span className="size-2 rounded-full bg-amber-300/80" />
          <span className="size-2 rounded-full bg-emerald-400/80" />
        </div>
        <div className="min-w-0">
          <p className="truncate text-center font-mono text-xs tracking-[0.18em] text-white/70">
            terminal: agents-prod
          </p>
        </div>
        <div className="w-10" />
      </div>

      <div className="relative max-h-[72svh] overflow-hidden rounded-b-3xl">
        <div className="pointer-events-none absolute inset-0 bg-[radial-gradient(800px_380px_at_16%_8%,rgba(34,197,94,0.12),transparent_60%),radial-gradient(700px_320px_at_90%_14%,rgba(56,189,248,0.10),transparent_60%)]" />
        <div
          className={cn(
            'relative max-h-[72svh] overflow-auto px-6 py-6 font-mono text-[12.5px] leading-relaxed sm:text-[13.5px]',
          )}
        >
          <div className="space-y-1">
            {bootRows.map((row) => (
              <div key={row.id} className="whitespace-pre-wrap break-words">
                {row.segments.map((segment, idx) => (
                  <span key={`${row.id}-${idx}`} className={segment.className}>
                    {segment.text}
                  </span>
                ))}
              </div>
            ))}

            <div className="whitespace-pre-wrap break-words">
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
                  <div key={row.id} className="whitespace-pre-wrap break-words">
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
