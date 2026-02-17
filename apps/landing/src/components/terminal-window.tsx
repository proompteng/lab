'use client'

import { motion } from 'motion/react'
import { forwardRef, useCallback, useEffect, useImperativeHandle, useMemo, useRef, useState } from 'react'
import { cn } from '@/lib/utils'

const COMMAND = 'kubectl get agentruns'
const MIN_VISIBLE_PX = 64
const MINIMIZE_SCALE = 0.13
const MAX_WINDOW_WIDTH_PX = 74 * 16
const MAX_WINDOW_HEIGHT_PX = 760
const FALLBACK_VIEWPORT = { width: 1280, height: 720 }
const TOP_MENU_BAR_HEIGHT_PX = 44
const MACOS_MINIMIZE_DURATION = 0.78
const MACOS_RESTORE_DURATION = 0.62
const MACOS_FULLSCREEN_DURATION = 0.38
const MACOS_FULLSCREEN_EASE = [0.21, 1, 0.35, 1] as const
const MACOS_RESTORE_EASE = [0.16, 1, 0.3, 1] as const
const MACOS_MINIMIZE_PATH = [0, 0.12, 0.28, 0.4, 0.52, 0.68, 0.86, 1] as const
const MACOS_RESTORE_PATH = [0, 0.16, 0.33, 0.5, 0.66, 0.82, 0.92, 1] as const
const MACOS_MINIMIZE_CURVE_EASE = [0.15, 0.98, 0.34, 0.98] as const
const MACOS_MINIMIZE_SLIDE_EASE = [0.22, 1, 0.34, 1] as const
const MACOS_MINIMIZE_CLIP_PATH = [
  'inset(0% 0% 0% 0%)',
  'inset(0% 0% 0% 0%)',
  'inset(0% 2% 0% 2%)',
  'inset(0% 8% 4% 8%)',
  'inset(2% 16% 24% 16%)',
  'inset(6% 22% 42% 22%)',
  'inset(12% 28% 70% 28%)',
  'inset(28% 36% 92% 36%)',
] as const
const MACOS_RESTORE_CLIP_PATH = [
  'inset(28% 36% 92% 36%)',
  'inset(12% 28% 70% 28%)',
  'inset(6% 22% 42% 22%)',
  'inset(2% 16% 24% 16%)',
  'inset(0% 8% 4% 8%)',
  'inset(0% 2% 0% 2%)',
  'inset(0% 0% 0% 0%)',
  'inset(0% 0% 0% 0%)',
] as const
const MINIMIZED_CLIP_PATH = MACOS_MINIMIZE_CLIP_PATH[MACOS_MINIMIZE_CLIP_PATH.length - 1]

type WindowMode = 'normal' | 'minimizing' | 'minimized' | 'restoring' | 'closed'
type FullscreenMode = 'normal' | 'fullscreen' | 'fullscreen-entering' | 'fullscreen-exiting'

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
    { text: formatTime(new Date()), className: 'text-[rgb(var(--terminal-text-faint)/0.45)]' },
    { text: '  ' },
    {
      text: level.padEnd(5),
      className:
        level === 'ERROR'
          ? 'text-[rgb(var(--terminal-text-red))]'
          : level === 'WARN'
            ? 'text-[rgb(var(--terminal-text-orange))]'
            : 'text-[rgb(var(--terminal-text-green))]',
    },
    { text: '  ' },
    { text: randomFrom(messages[level]), className: 'text-[rgb(var(--terminal-text-primary)/0.82)]' },
  ])
}

function clamp(value: number, min: number, max: number) {
  return Math.min(Math.max(value, min), max)
}

function pad(text: string, width: number) {
  return text.length >= width ? `${text.slice(0, Math.max(0, width - 1))}\u2026` : text.padEnd(width)
}

function getViewport() {
  if (typeof window === 'undefined') {
    return FALLBACK_VIEWPORT
  }

  return { width: window.innerWidth, height: window.innerHeight }
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

export type TerminalWindowHandle = {
  restore: () => void
  expand: () => void
  minimize: () => void
  toggleFullscreen: () => void
  close: () => void
}

type TerminalWindowProps = {
  className?: string
  menuBarButtonRef?: React.RefObject<HTMLElement | null>
  onMinimizedStateChange?: (isMinimized: boolean) => void
  onClosedStateChange?: (isClosed: boolean) => void
}

const TerminalWindow = forwardRef<TerminalWindowHandle, TerminalWindowProps>(
  ({ className, menuBarButtonRef, onMinimizedStateChange, onClosedStateChange }, ref) => {
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
    const windowModeRef = useRef<WindowMode>('normal')
    const fullscreenModeRef = useRef<FullscreenMode>('normal')
    const restoreToFullscreenRef = useRef(false)
    const [viewport, setViewport] = useState(() => FALLBACK_VIEWPORT)
    const [offset, setOffset] = useState({ x: 0, y: 0 })
    const [windowMode, setWindowMode] = useState<WindowMode>('normal')
    const [fullscreenMode, setFullscreenMode] = useState<FullscreenMode>('normal')
    const [minimizeOffset, setMinimizeOffset] = useState({ x: 0, y: 0 })
    const isClosedRef = useRef(false)

    useEffect(() => {
      windowModeRef.current = windowMode
    }, [windowMode])
    useEffect(() => {
      fullscreenModeRef.current = fullscreenMode
    }, [fullscreenMode])
    useEffect(() => {
      const handleResize = () => setViewport(getViewport())
      handleResize()
      window.addEventListener('resize', handleResize)
      return () => {
        window.removeEventListener('resize', handleResize)
      }
    }, [])

    const beginDrag = useCallback(
      (pointerId: number, startX: number, startY: number) => {
        if (!windowRef.current || dragRef.current || windowMode !== 'normal' || fullscreenMode !== 'normal') {
          return
        }
        dragRef.current = {
          pointerId,
          startX,
          startY,
          startOffsetX: offset.x,
          startOffsetY: offset.y,
        }
      },
      [offset.x, offset.y, windowMode, fullscreenMode],
    )

    const endDrag = useCallback(() => {
      dragRef.current = null
    }, [])

    const getMinimizeTarget = useCallback(() => {
      if (!menuBarButtonRef?.current) return null
      const menuBarRect = menuBarButtonRef.current.getBoundingClientRect()
      const isFullscreenLike = fullscreenMode === 'fullscreen'
      const windowCenterX = viewport.width / 2 + (isFullscreenLike ? 0 : offset.x)
      const windowCenterY = viewport.height / 2 + (isFullscreenLike ? TOP_MENU_BAR_HEIGHT_PX / 2 : offset.y)
      return {
        x: menuBarRect.left + menuBarRect.width / 2 - windowCenterX,
        y: menuBarRect.top + menuBarRect.height / 2 - windowCenterY,
      }
    }, [fullscreenMode, menuBarButtonRef, offset.x, offset.y, viewport.height, viewport.width])

    const getMinimizeTargetFallback = useCallback(() => {
      // If we can't measure the dock icon, still minimize to the dock area (bottom-center).
      // This avoids "minimize does nothing" when refs aren't available yet (SSR/fast interactions).
      const isFullscreenLike = fullscreenMode === 'fullscreen'
      const windowCenterX = viewport.width / 2 + (isFullscreenLike ? 0 : offset.x)
      const windowCenterY = viewport.height / 2 + (isFullscreenLike ? TOP_MENU_BAR_HEIGHT_PX / 2 : offset.y)

      const dockCenterX = viewport.width / 2
      const dockCenterY = viewport.height - 38
      return {
        x: dockCenterX - windowCenterX,
        y: dockCenterY - windowCenterY,
      }
    }, [fullscreenMode, offset.x, offset.y, viewport.height, viewport.width])

    const minimizeWindow = useCallback(() => {
      if (windowMode !== 'normal') return
      if (fullscreenMode === 'fullscreen-entering' || fullscreenMode === 'fullscreen-exiting') return

      const targetOffset = getMinimizeTarget() ?? getMinimizeTargetFallback()

      restoreToFullscreenRef.current = fullscreenMode === 'fullscreen'
      setMinimizeOffset(targetOffset)
      setWindowMode('minimizing')
      onMinimizedStateChange?.(false)
    }, [fullscreenMode, getMinimizeTarget, getMinimizeTargetFallback, onMinimizedStateChange, windowMode])

    const restoreWindow = useCallback(() => {
      if (windowMode === 'closed') {
        isClosedRef.current = false
        onClosedStateChange?.(false)
        setWindowMode('normal')
        setMinimizeOffset({ x: 0, y: 0 })
        onMinimizedStateChange?.(false)
        return
      }

      if (windowMode !== 'minimized') return

      const targetOffset = getMinimizeTarget()
      if (targetOffset) setMinimizeOffset(targetOffset)
      setWindowMode('restoring')
      onMinimizedStateChange?.(false)
    }, [getMinimizeTarget, onClosedStateChange, onMinimizedStateChange, windowMode])

    const closeWindow = useCallback(() => {
      if (windowMode !== 'normal') return
      if (fullscreenMode === 'fullscreen-entering' || fullscreenMode === 'fullscreen-exiting') return

      // macOS red traffic light closes the window, not the app. We'll hide instantly (no animation),
      // and keep the dock "running" indicator handled by the parent.
      isClosedRef.current = true
      onClosedStateChange?.(true)
      restoreToFullscreenRef.current = false
      setFullscreenMode('normal')
      setWindowMode('closed')
      onMinimizedStateChange?.(false)
    }, [fullscreenMode, onClosedStateChange, onMinimizedStateChange, windowMode])

    const toggleFullscreen = useCallback(() => {
      if (windowMode !== 'normal') return
      if (fullscreenMode === 'fullscreen') {
        setFullscreenMode('fullscreen-exiting')
        return
      }
      if (fullscreenMode === 'normal') {
        setFullscreenMode('fullscreen-entering')
      }
    }, [fullscreenMode, windowMode])

    useImperativeHandle(
      ref,
      () => ({
        restore: restoreWindow,
        expand: restoreWindow,
        minimize: minimizeWindow,
        toggleFullscreen,
        close: closeWindow,
      }),
      [closeWindow, minimizeWindow, restoreWindow, toggleFullscreen],
    )

    const bootRows = useMemo<Row[]>(
      () => [
        mkRow('boot-0', [
          { text: 'proompteng ', className: 'text-[rgb(var(--terminal-text-green))]' },
          { text: 'agent control plane', className: 'text-[rgb(var(--terminal-text-primary)/0.82)]' },
        ]),
        mkRow('boot-1', [
          { text: 'connecting ', className: 'text-[rgb(var(--terminal-text-secondary)/0.72)]' },
          { text: 'cluster=agents-prod ', className: 'text-[rgb(var(--terminal-text-blue))]' },
          { text: '... ok', className: 'text-[rgb(var(--terminal-text-green))]' },
        ]),
        mkRow('boot-2', [
          { text: 'auth ', className: 'text-[rgb(var(--terminal-text-secondary)/0.72)]' },
          { text: 'serviceaccount=landing-ro ', className: 'text-[rgb(var(--terminal-text-primary)/0.82)]' },
          { text: '... ok', className: 'text-[rgb(var(--terminal-text-green))]' },
        ]),
        mkRow('boot-3', [
          { text: 'tailing ', className: 'text-[rgb(var(--terminal-text-secondary)/0.72)]' },
          { text: 'agents-controller logs', className: 'text-[rgb(var(--terminal-text-primary)/0.82)]' },
          { text: ' (live)', className: 'text-[rgb(var(--terminal-text-faint)/0.45)]' },
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
      const updateDragOffset = (clientX: number, clientY: number) => {
        if (!dragRef.current) return
        if (!windowRef.current) return

        const container = windowRef.current.offsetParent
        const containerRect =
          container instanceof HTMLElement
            ? container.getBoundingClientRect()
            : { width: window.innerWidth, height: window.innerHeight }
        const windowRect = windowRef.current.getBoundingClientRect()

        const deltaX = clientX - dragRef.current.startX
        const deltaY = clientY - dragRef.current.startY
        const nextX = dragRef.current.startOffsetX + deltaX
        const nextY = dragRef.current.startOffsetY + deltaY

        const maxX = containerRect.width / 2 + windowRect.width / 2 - MIN_VISIBLE_PX
        const minX = MIN_VISIBLE_PX - containerRect.width / 2 - windowRect.width / 2
        const maxY = containerRect.height / 2 + windowRect.height / 2 - MIN_VISIBLE_PX
        const minY = MIN_VISIBLE_PX - containerRect.height / 2 - windowRect.height / 2
        const topBoundY = TOP_MENU_BAR_HEIGHT_PX + 12 + windowRect.height / 2 - containerRect.height / 2

        setOffset({ x: clamp(nextX, minX, maxX), y: clamp(nextY, Math.max(minY, topBoundY), maxY) })
      }

      const onPointerMove = (event: PointerEvent) => {
        if (!dragRef.current) return
        if (dragRef.current.pointerId < 0) return
        if (event.pointerId !== dragRef.current.pointerId) return
        updateDragOffset(event.clientX, event.clientY)
      }

      const onMouseMove = (event: MouseEvent) => {
        if (!dragRef.current) return
        if (dragRef.current.pointerId !== -1) return
        updateDragOffset(event.clientX, event.clientY)
      }

      const onTouchMove = (event: TouchEvent) => {
        if (!dragRef.current) return
        if (dragRef.current.pointerId !== -2) return
        if (event.touches.length === 0) return
        const touch = event.touches[0]
        if (!touch) return
        event.preventDefault()
        updateDragOffset(touch.clientX, touch.clientY)
      }

      const onPointerUp = (event: PointerEvent) => {
        if (!dragRef.current) return
        if (dragRef.current.pointerId < 0) return
        if (event.pointerId !== dragRef.current.pointerId) return
        endDrag()
      }

      const onMouseUp = () => {
        if (!dragRef.current) return
        if (dragRef.current.pointerId !== -1) return
        endDrag()
      }

      const onTouchEnd = () => {
        if (!dragRef.current) return
        if (dragRef.current.pointerId !== -2) return
        endDrag()
      }

      window.addEventListener('pointermove', onPointerMove)
      window.addEventListener('pointerup', onPointerUp)
      window.addEventListener('pointercancel', onPointerUp)
      window.addEventListener('mousemove', onMouseMove)
      window.addEventListener('mouseup', onMouseUp)
      window.addEventListener('touchmove', onTouchMove, { passive: false })
      window.addEventListener('touchend', onTouchEnd)
      window.addEventListener('touchcancel', onTouchEnd)
      return () => {
        window.removeEventListener('pointermove', onPointerMove)
        window.removeEventListener('pointerup', onPointerUp)
        window.removeEventListener('pointercancel', onPointerUp)
        window.removeEventListener('mousemove', onMouseMove)
        window.removeEventListener('mouseup', onMouseUp)
        window.removeEventListener('touchmove', onTouchMove)
        window.removeEventListener('touchend', onTouchEnd)
        window.removeEventListener('touchcancel', onTouchEnd)
      }
    }, [endDrag])

    useEffect(() => {
      if (reducedMotion) {
        setPhase('output')
        setCommandText(COMMAND)
        setRows((prev) => {
          const initial = [
            mkRow('out-header', [
              { text: formatKubectlHeader(), className: 'text-[rgb(var(--terminal-text-faint)/0.65)]' },
            ]),
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
                className: 'text-[rgb(var(--terminal-text-primary)/0.82)]',
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
                className: 'text-[rgb(var(--terminal-text-primary)/0.82)]',
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
                  mkRow('out-header', [
                    { text: formatKubectlHeader(), className: 'text-[rgb(var(--terminal-text-faint)/0.65)]' },
                  ]),
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
                      className: 'text-[rgb(var(--terminal-text-primary)/0.82)]',
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
                      className: 'text-[rgb(var(--terminal-text-primary)/0.82)]',
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
                      className: 'text-[rgb(var(--terminal-text-primary)/0.82)]',
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
              if (windowModeRef.current !== 'normal' || fullscreenModeRef.current !== 'normal') return prev
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

    const isMenuTargeting = windowMode === 'minimizing' || windowMode === 'minimized' || windowMode === 'restoring'
    const isHidden = windowMode === 'minimized' || windowMode === 'closed'
    const isControlLocked =
      windowMode !== 'normal' || fullscreenMode === 'fullscreen-entering' || fullscreenMode === 'fullscreen-exiting'
    const normalWidth = clamp(viewport.width * 0.95, MAX_WINDOW_WIDTH_PX / 4, MAX_WINDOW_WIDTH_PX)
    const normalHeight = clamp(viewport.height * 0.72, 280, MAX_WINDOW_HEIGHT_PX)
    const isFullscreenTarget = fullscreenMode === 'fullscreen' || fullscreenMode === 'fullscreen-entering'
    const fullscreenHeight = Math.max(260, viewport.height - TOP_MENU_BAR_HEIGHT_PX)
    const fullscreenY = isFullscreenTarget ? TOP_MENU_BAR_HEIGHT_PX / 2 : 0
    const currentBaseX = isFullscreenTarget ? 0 : offset.x
    const currentBaseY = isFullscreenTarget ? fullscreenY : offset.y
    const targetWindowX = isFullscreenTarget ? 0 : offset.x
    const targetWindowY = isFullscreenTarget ? fullscreenY : offset.y
    const targetWindowWidth = isFullscreenTarget ? viewport.width : normalWidth
    const targetWindowHeight = isFullscreenTarget ? fullscreenHeight : normalHeight
    const targetBaseX = isMenuTargeting ? currentBaseX + minimizeOffset.x : currentBaseX
    const targetBaseY = isMenuTargeting ? currentBaseY + minimizeOffset.y : currentBaseY
    const minimizedX = isMenuTargeting ? minimizeOffset.x : 0
    const minimizedY = isMenuTargeting ? minimizeOffset.y : 0

    const windowAnimate = useMemo(() => {
      if (windowMode === 'minimizing') {
        return {
          x: [
            currentBaseX,
            currentBaseX,
            currentBaseX + minimizedX * 0.04,
            currentBaseX + minimizedX * 0.18,
            currentBaseX + minimizedX * 0.42,
            currentBaseX + minimizedX * 0.68,
            currentBaseX + minimizedX * 0.86,
            targetBaseX,
          ],
          y: [
            currentBaseY,
            currentBaseY,
            currentBaseY + minimizedY * 0.08,
            currentBaseY + minimizedY * 0.22,
            currentBaseY + minimizedY * 0.5,
            currentBaseY + minimizedY * 0.72,
            currentBaseY + minimizedY * 0.86,
            targetBaseY,
          ],
          width: [
            targetWindowWidth,
            targetWindowWidth,
            targetWindowWidth,
            targetWindowWidth,
            targetWindowWidth,
            targetWindowWidth,
            targetWindowWidth,
            targetWindowWidth,
          ],
          height: [
            targetWindowHeight,
            targetWindowHeight,
            targetWindowHeight,
            targetWindowHeight,
            targetWindowHeight,
            targetWindowHeight,
            targetWindowHeight,
            targetWindowHeight,
          ],
          scaleX: [1, 1, 0.95, 0.68, 0.42, 0.24, 0.16, MINIMIZE_SCALE],
          scaleY: [1, 1, 1, 0.88, 0.64, 0.36, 0.2, MINIMIZE_SCALE],
          opacity: [1, 1, 0.97, 0.82, 0.5, 0.26, 0.12, 0],
          skewX: ['0deg', '-4deg', '-12deg', '-24deg', '-30deg', '-24deg', '-14deg', '-8deg'],
          rotateZ: ['0deg', '0.2deg', '0.6deg', '-0.6deg', '-0.45deg', '-0.25deg', '0deg', '0deg'],
          clipPath: [...MACOS_MINIMIZE_CLIP_PATH],
          filter: [
            'blur(0px)',
            'blur(0px)',
            'blur(0.12px)',
            'blur(0.24px)',
            'blur(0.16px)',
            'blur(0.08px)',
            'blur(0.04px)',
            'blur(0px)',
          ],
        }
      }

      if (windowMode === 'minimized') {
        return {
          x: targetBaseX,
          y: targetBaseY,
          width: targetWindowWidth,
          height: targetWindowHeight,
          scaleX: MINIMIZE_SCALE,
          scaleY: MINIMIZE_SCALE,
          opacity: 0,
          skewX: '-8deg',
          rotateZ: '0deg',
          clipPath: MINIMIZED_CLIP_PATH,
          filter: 'blur(0px)',
        }
      }

      if (windowMode === 'restoring') {
        return {
          x: [
            targetBaseX,
            targetBaseX - minimizedX * 0.08,
            targetBaseX - minimizedX * 0.32,
            targetBaseX - minimizedX * 0.58,
            targetBaseX - minimizedX * 0.32,
            targetBaseX - minimizedX * 0.08,
            targetBaseX - minimizedX * 0.02,
            currentBaseX,
          ],
          y: [
            targetBaseY,
            targetBaseY - minimizedY * 0.06,
            targetBaseY - minimizedY * 0.2,
            targetBaseY - minimizedY * 0.48,
            targetBaseY - minimizedY * 0.22,
            targetBaseY - minimizedY * 0.06,
            targetBaseY - minimizedY * 0.02,
            currentBaseY,
          ],
          width: [
            targetWindowWidth,
            targetWindowWidth,
            targetWindowWidth,
            targetWindowWidth,
            targetWindowWidth,
            targetWindowWidth,
            targetWindowWidth,
            targetWindowWidth,
          ],
          height: [
            targetWindowHeight,
            targetWindowHeight,
            targetWindowHeight,
            targetWindowHeight,
            targetWindowHeight,
            targetWindowHeight,
            targetWindowHeight,
            targetWindowHeight,
          ],
          scaleX: [MINIMIZE_SCALE, 0.18, 0.35, 0.6, 0.84, 0.96, 0.99, 1],
          scaleY: [MINIMIZE_SCALE, 0.22, 0.48, 0.72, 0.84, 0.97, 0.99, 1],
          opacity: [0, 0.2, 0.56, 0.84, 0.94, 0.98, 1, 1],
          skewX: ['-8deg', '-6deg', '-3deg', '-2deg', '-1deg', '-0.5deg', '-0.2deg', '0deg'],
          rotateZ: ['0deg', '0.1deg', '-0.2deg', '-0.08deg', '-0.05deg', '0deg', '0deg', '0deg'],
          clipPath: [...MACOS_RESTORE_CLIP_PATH],
          filter: [
            'blur(0px)',
            'blur(0.06px)',
            'blur(0.06px)',
            'blur(0.04px)',
            'blur(0.02px)',
            'blur(0.01px)',
            'blur(0px)',
            'blur(0px)',
          ],
        }
      }

      if (windowMode === 'closed') {
        return {
          x: targetWindowX,
          y: targetWindowY,
          width: targetWindowWidth,
          height: targetWindowHeight,
          scaleX: 1,
          scaleY: 1,
          opacity: 0,
          filter: 'blur(0px)',
        }
      }

      return {
        x: targetWindowX,
        y: targetWindowY,
        width: targetWindowWidth,
        height: targetWindowHeight,
        scaleX: 1,
        scaleY: 1,
        opacity: 1,
        filter: 'blur(0px)',
      }
    }, [
      minimizedX,
      minimizedY,
      currentBaseX,
      currentBaseY,
      targetWindowHeight,
      targetWindowWidth,
      targetWindowX,
      targetWindowY,
      targetBaseX,
      targetBaseY,
      windowMode,
    ])

    const motionTransition = useMemo(() => {
      if (reducedMotion) {
        return {
          duration: 0.0001,
        }
      }

      if (windowMode === 'minimizing') {
        return {
          x: {
            type: 'tween',
            duration: MACOS_MINIMIZE_DURATION,
            times: MACOS_MINIMIZE_PATH,
            ease: [0.15, 0.98, 0.34, 0.98] as const,
          },
          y: {
            type: 'tween',
            duration: MACOS_MINIMIZE_DURATION,
            times: MACOS_MINIMIZE_PATH,
            ease: MACOS_MINIMIZE_SLIDE_EASE,
          },
          width: {
            type: 'tween',
            duration: MACOS_MINIMIZE_DURATION,
            times: MACOS_MINIMIZE_PATH,
            ease: [0.22, 1, 0.35, 1] as const,
          },
          height: {
            type: 'tween',
            duration: MACOS_MINIMIZE_DURATION,
            times: MACOS_MINIMIZE_PATH,
            ease: [0.22, 1, 0.35, 1] as const,
          },
          scaleX: {
            type: 'tween',
            duration: MACOS_MINIMIZE_DURATION,
            times: MACOS_MINIMIZE_PATH,
            ease: MACOS_MINIMIZE_CURVE_EASE,
          },
          scaleY: {
            type: 'tween',
            duration: MACOS_MINIMIZE_DURATION,
            times: MACOS_MINIMIZE_PATH,
            ease: [0.1, 0.95, 0.25, 1] as const,
          },
          skewX: {
            type: 'tween',
            duration: MACOS_MINIMIZE_DURATION,
            times: MACOS_MINIMIZE_PATH,
            ease: [0.25, 1, 0.35, 1] as const,
          },
          rotateZ: {
            type: 'tween',
            duration: MACOS_MINIMIZE_DURATION,
            times: MACOS_MINIMIZE_PATH,
            ease: [0.14, 0.98, 0.32, 1] as const,
          },
          opacity: {
            type: 'tween',
            duration: MACOS_MINIMIZE_DURATION,
            times: MACOS_MINIMIZE_PATH,
            ease: [0.26, 1, 0.35, 1] as const,
          },
          clipPath: {
            type: 'tween',
            duration: MACOS_MINIMIZE_DURATION,
            times: MACOS_MINIMIZE_PATH,
            ease: [0.18, 1, 0.28, 1] as const,
          },
          filter: {
            type: 'tween',
            duration: MACOS_MINIMIZE_DURATION,
            times: MACOS_MINIMIZE_PATH,
            ease: [0.2, 1, 0.28, 1] as const,
          },
        }
      }

      if (windowMode === 'restoring') {
        return {
          x: { type: 'tween', duration: MACOS_RESTORE_DURATION, times: MACOS_RESTORE_PATH, ease: MACOS_RESTORE_EASE },
          y: { type: 'tween', duration: MACOS_RESTORE_DURATION, times: MACOS_RESTORE_PATH, ease: MACOS_RESTORE_EASE },
          width: {
            type: 'tween',
            duration: MACOS_RESTORE_DURATION,
            times: MACOS_RESTORE_PATH,
            ease: MACOS_RESTORE_EASE,
          },
          height: {
            type: 'tween',
            duration: MACOS_RESTORE_DURATION,
            times: MACOS_RESTORE_PATH,
            ease: MACOS_RESTORE_EASE,
          },
          scaleX: {
            type: 'tween',
            duration: MACOS_RESTORE_DURATION,
            times: MACOS_RESTORE_PATH,
            ease: [0.2, 0.98, 0.36, 1] as const,
          },
          scaleY: {
            type: 'tween',
            duration: MACOS_RESTORE_DURATION,
            times: MACOS_RESTORE_PATH,
            ease: [0.22, 0.98, 0.42, 1] as const,
          },
          skewX: {
            type: 'tween',
            duration: MACOS_RESTORE_DURATION,
            times: MACOS_RESTORE_PATH,
            ease: MACOS_RESTORE_EASE,
          },
          rotateZ: {
            type: 'tween',
            duration: MACOS_RESTORE_DURATION,
            times: MACOS_RESTORE_PATH,
            ease: MACOS_RESTORE_EASE,
          },
          opacity: {
            type: 'tween',
            duration: MACOS_RESTORE_DURATION,
            times: MACOS_RESTORE_PATH,
            ease: MACOS_RESTORE_EASE,
          },
          clipPath: {
            type: 'tween',
            duration: MACOS_RESTORE_DURATION,
            times: MACOS_RESTORE_PATH,
            ease: [0.25, 1, 0.4, 1] as const,
          },
          filter: {
            type: 'tween',
            duration: MACOS_RESTORE_DURATION,
            times: MACOS_RESTORE_PATH,
            ease: MACOS_RESTORE_EASE,
          },
        }
      }

      if (fullscreenMode === 'fullscreen-entering' || fullscreenMode === 'fullscreen-exiting') {
        return {
          x: { duration: MACOS_FULLSCREEN_DURATION, ease: MACOS_FULLSCREEN_EASE },
          y: { duration: MACOS_FULLSCREEN_DURATION, ease: MACOS_FULLSCREEN_EASE },
          width: { duration: MACOS_FULLSCREEN_DURATION, ease: MACOS_FULLSCREEN_EASE },
          height: { duration: MACOS_FULLSCREEN_DURATION, ease: MACOS_FULLSCREEN_EASE },
          scaleX: { duration: MACOS_FULLSCREEN_DURATION },
          scaleY: { duration: MACOS_FULLSCREEN_DURATION },
          opacity: { duration: MACOS_FULLSCREEN_DURATION },
          filter: { duration: MACOS_FULLSCREEN_DURATION },
        }
      }

      return { duration: 0.0001 }
    }, [fullscreenMode, reducedMotion, windowMode])

    const handleWindowMotionComplete = useCallback(() => {
      if (windowModeRef.current === 'minimizing') {
        onMinimizedStateChange?.(true)
        setWindowMode('minimized')
        if (restoreToFullscreenRef.current) {
          setFullscreenMode('normal')
        }
      }

      if (windowModeRef.current === 'restoring') {
        setWindowMode('normal')
        setMinimizeOffset({ x: 0, y: 0 })
        if (restoreToFullscreenRef.current) {
          restoreToFullscreenRef.current = false
          setFullscreenMode('fullscreen-entering')
        }
      }

      if (fullscreenModeRef.current === 'fullscreen-entering') {
        setFullscreenMode('fullscreen')
      }

      if (fullscreenModeRef.current === 'fullscreen-exiting') {
        setFullscreenMode('normal')
      }
    }, [onMinimizedStateChange])

    return (
      <motion.div
        ref={windowRef}
        aria-hidden={isHidden}
        className={cn(
          'pointer-events-none fixed z-50 terminal-squircle-shell select-none overflow-hidden left-1/2 top-1/2',
          '-translate-x-1/2 -translate-y-1/2',
          'font-terminal',
          'touch-none origin-bottom transform-gpu will-change-transform',
          isHidden ? 'invisible' : 'visible',
          isHidden ? 'pointer-events-none' : 'pointer-events-auto',
          className,
        )}
        animate={windowAnimate}
        transition={motionTransition}
        initial={false}
        onAnimationComplete={handleWindowMotionComplete}
      >
        {/* biome-ignore lint/a11y/noStaticElementInteractions: Custom title bar needs pointer listeners for dragging. */}
        <div
          className={cn(
            'absolute inset-x-0 top-0 z-20 flex h-10 cursor-default items-center justify-between gap-3.5 px-3 py-1',
            'touch-none bg-[rgb(var(--terminal-titlebar-bg))] border-[color:rgb(var(--terminal-shell-border)/0.45)]',
            'text-left outline-none',
          )}
          onPointerDown={(event) => {
            beginDrag(event.pointerId, event.clientX, event.clientY)
            try {
              ;(event.currentTarget as HTMLDivElement).setPointerCapture(event.pointerId)
            } catch {
              // Ignore pointer-capture failures when not supported.
            }
            event.preventDefault()
          }}
          onMouseDown={(event) => {
            if (event.button !== 0) return
            beginDrag(-1, event.clientX, event.clientY)
            event.preventDefault()
          }}
          onTouchStart={(event) => {
            const touch = event.touches[0]
            if (!touch) return
            beginDrag(-2, touch.clientX, touch.clientY)
            event.preventDefault()
          }}
        >
          <div className="group/stoplights flex items-center gap-[7px] px-0.5 py-0.5">
            <button
              type="button"
              aria-label="Close"
              onPointerDown={(event) => event.stopPropagation()}
              onClick={(event) => {
                event.preventDefault()
                event.stopPropagation()
                closeWindow()
              }}
              className={cn(
                // macOS-like inactive stoplight (neutral gray), color+glyph only on hover.
                'relative grid size-[14px] place-items-center rounded-full bg-[#d0d0d2] ring-1 ring-inset ring-[#bdbdc0]',
                'shadow-[0_0.5px_0_rgba(255,255,255,0.55)_inset] transition-colors duration-150',
                'group-hover/stoplights:bg-[#ed6a5f] group-hover/stoplights:ring-[#e24b41]',
              )}
            >
              <svg
                viewBox="0 0 85.4 85.4"
                className="absolute inset-0 size-[14px] opacity-0 transition-opacity duration-150 group-hover/stoplights:opacity-100"
                aria-hidden="true"
              >
                <g clipRule="evenodd" fill="#460804" fillRule="evenodd">
                  <path d="m22.5 57.8 35.3-35.3c1.4-1.4 3.6-1.4 5 0l.1.1c1.4 1.4 1.4 3.6 0 5l-35.3 35.3c-1.4 1.4-3.6 1.4-5 0l-.1-.1c-1.3-1.4-1.3-3.6 0-5z" />
                  <path d="m27.6 22.5 35.3 35.3c1.4 1.4 1.4 3.6 0 5l-.1.1c-1.4 1.4-3.6 1.4-5 0l-35.3-35.3c-1.4-1.4-1.4-3.6 0-5l.1-.1c1.4-1.3 3.6-1.3 5 0z" />
                </g>
              </svg>
            </button>
            <button
              type="button"
              aria-label="Minimize"
              onPointerDown={(event) => {
                event.stopPropagation()
                if (windowMode !== 'normal') return
                if (fullscreenMode === 'fullscreen-entering' || fullscreenMode === 'fullscreen-exiting') return
              }}
              onKeyDown={(event) => {
                if (event.key !== ' ' && event.key !== 'Enter') return
                event.preventDefault()
                event.stopPropagation()
                if (windowMode !== 'normal') return
                if (fullscreenMode === 'fullscreen-entering' || fullscreenMode === 'fullscreen-exiting') return
                minimizeWindow()
              }}
              onClick={(event) => {
                event.preventDefault()
                event.stopPropagation()
                if (windowMode !== 'normal') return
                if (fullscreenMode === 'fullscreen-entering' || fullscreenMode === 'fullscreen-exiting') return
                minimizeWindow()
              }}
              className={cn(
                'relative grid size-[14px] place-items-center rounded-full bg-[#d0d0d2] ring-1 ring-inset ring-[#bdbdc0]',
                'shadow-[0_0.5px_0_rgba(255,255,255,0.55)_inset] transition-colors duration-150',
                'group-hover/stoplights:bg-[#f6be50] group-hover/stoplights:ring-[#e1a73e]',
                isControlLocked ? 'pointer-events-none' : '',
              )}
            >
              <svg
                viewBox="0 0 85.4 85.4"
                className="absolute inset-0 size-[14px] origin-center scale-[1.14] opacity-0 transition-opacity duration-150 group-hover/stoplights:opacity-100"
                fill="#90591d"
                aria-hidden="true"
              >
                <path d="m17.8 39.1h49.9c1.9 0 3.5 1.6 3.5 3.5v.1c0 1.9-1.6 3.5-3.5 3.5h-49.9c-1.9 0-3.5-1.6-3.5-3.5v-.1c0-1.9 1.5-3.5 3.5-3.5z" />
              </svg>
            </button>
            <button
              type="button"
              aria-label="Expand"
              onPointerDown={(event) => {
                event.stopPropagation()
                if (isControlLocked) return
                event.preventDefault()
              }}
              onKeyDown={(event) => {
                if (event.key !== ' ' && event.key !== 'Enter') return
                event.preventDefault()
                event.stopPropagation()
                if (isControlLocked) return
                toggleFullscreen()
              }}
              onClick={(event) => {
                event.preventDefault()
                event.stopPropagation()
                if (isControlLocked) return
                toggleFullscreen()
              }}
              className={cn(
                'relative grid size-[14px] place-items-center rounded-full bg-[#d0d0d2] ring-1 ring-inset ring-[#bdbdc0]',
                'shadow-[0_0.5px_0_rgba(255,255,255,0.55)_inset] transition-colors duration-150',
                'group-hover/stoplights:bg-[#61c555] group-hover/stoplights:ring-[#2dac2f]',
                isControlLocked ? 'pointer-events-none' : '',
              )}
            >
              <svg
                viewBox="0 0 85.4 85.4"
                className="absolute inset-0 size-[14px] origin-center -rotate-[135deg] opacity-0 transition-opacity duration-150 group-hover/stoplights:opacity-100"
                fill="#2a6218"
                aria-hidden="true"
              >
                <path d="m31.2 20.8h26.7c3.6 0 6.5 2.9 6.5 6.5v26.7zm23.2 43.7h-26.8c-3.6 0-6.5-2.9-6.5-6.5v-26.8z" />
              </svg>
            </button>
          </div>
          <div className="min-w-0">
            <p className="font-display truncate text-center text-base font-medium text-[rgb(var(--terminal-titlebar-text))]">
              control plane
            </p>
          </div>
          <div className="w-10" />
        </div>

        <div className="relative z-0 h-full overflow-hidden pt-10">
          <div
            className={cn(
              'relative h-full overflow-auto px-5 py-4 text-[12.5px] leading-relaxed sm:text-[13.5px]',
              'bg-[linear-gradient(180deg,rgb(var(--terminal-window-bg-top)),rgb(var(--terminal-window-bg-bottom)))]',
            )}
          >
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
                <span className="text-[rgb(var(--terminal-text-green))]">➜</span>
                <span className="text-[rgb(var(--terminal-text-faint)/0.45)]"> </span>
                <span className="text-[rgb(var(--terminal-text-blue))]">agents</span>
                <span className="text-[rgb(var(--terminal-text-faint)/0.45)]"> </span>
                <span className="text-[rgb(var(--terminal-text-primary)/0.82)]">
                  {phase === 'boot' ? '' : commandText}
                </span>
                {phase === 'typing' ? (
                  <span className="ml-0.5 inline-block h-4 w-2 translate-y-[2px] bg-[rgb(var(--terminal-text-primary)/0.82)]" />
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
      </motion.div>
    )
  },
)

export default TerminalWindow
