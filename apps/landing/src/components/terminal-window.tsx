'use client'

import { motion } from 'motion/react'
import { forwardRef, useCallback, useEffect, useImperativeHandle, useMemo, useRef, useState } from 'react'
import { cn } from '@/lib/utils'

const COMMAND = 'kubectl -n agents get agentrun -w'
const MIN_VISIBLE_PX = 64
const MINIMIZE_SCALE = 0.16
const MAX_WINDOW_WIDTH_PX = 74 * 16
const MAX_WINDOW_HEIGHT_PX = 900
const FALLBACK_VIEWPORT = { width: 1280, height: 720, left: 0, top: 0 }
const TOP_MENU_BAR_HEIGHT_PX = 44
const DOCK_SAFE_AREA_PX = 96
const MINIMIZE_DURATION = 0.3
const MINIMIZE_EASE = [0.32, 0, 0.67, 0] as const
const RESTORE_SPRING = { type: 'spring', stiffness: 380, damping: 32, mass: 0.75 } as const
const FULLSCREEN_SPRING = { type: 'spring', stiffness: 320, damping: 34, mass: 0.88 } as const

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

type SessionEvent = {
  event: string
  message: string
  level?: 'INFO' | 'WARN' | 'ERROR'
}

type TranscriptRow = {
  time: string
  event: string
  message: string
}

const INITIAL_TRANSCRIPT: readonly TranscriptRow[] = [
  {
    time: '01:18:22',
    event: 'response_item.function_call',
    message: 'exec_command(cmd="kubectl -n agents apply -f charts/agents/examples/agentrun-workflow-smoke.yaml")',
  },
  {
    time: '01:18:23',
    event: 'response_item.function_call_output',
    message: 'agentrun.agents.proompteng.ai/agents-workflow-smoke configured',
  },
  {
    time: '01:18:23',
    event: 'response_item.function_call',
    message:
      'exec_command(cmd="kubectl -n agents get agentrun agents-workflow-smoke -o jsonpath=\'{.status.phase} {.status.conditions[?(@.type=="Accepted")].reason}\'")',
  },
  {
    time: '01:18:24',
    event: 'response_item.function_call_output',
    message: 'Running Submitted',
  },
]

const OBFUSCATED_NAMESPACES = ['agents', 'agents-stg', 'agents-dev', 'agents-canary'] as const
const OBFUSCATED_RUN_STEMS = ['policy', 'replay', 'audit', 'ledger', 'router', 'dispatch'] as const
const OBFUSCATED_AGENT_NAMES = ['codex-agent', 'smoke-agent', 'native-workflow-agent', 'ops-agent'] as const
const OBFUSCATED_IMPLEMENTATIONS = ['smoke-impl', 'codex-impl-sample', 'codex-native-workflow-impl'] as const
const OBFUSCATED_REPOSITORIES = ['proompteng/lab', 'proompteng/platform', 'proompteng/ops'] as const
const OBFUSCATED_HEAD_BRANCHES = ['codex/agents/2614', 'codex/agents/3241', 'codex/workflow/1182'] as const
const OBFUSCATED_TTLS = [600, 900, 1800] as const

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

function formatIso(now: Date) {
  return now.toISOString().replace(/\.\d{3}Z$/, 'Z')
}

function mkRow(id: string, segments: Segment[]): Row {
  return { id, segments }
}

function randomFrom<T>(items: readonly T[]) {
  return items[Math.floor(Math.random() * items.length)]
}

function generateAgentRunName() {
  const nouns = OBFUSCATED_RUN_STEMS
  const tails = ['a3f2', '9c1b', '77de', '0b42', 'c8aa', '3f1d', 'e204', '6a9e'] as const
  const noun = randomFrom(nouns)
  const tail = randomFrom(tails)
  return `${noun}-${tail}`
}

function generateLogRow(index: number) {
  const run = `${generateAgentRunName()}-${String(index).padStart(2, '0')}`
  const namespace = randomFrom(OBFUSCATED_NAMESPACES)
  const agentName = randomFrom(OBFUSCATED_AGENT_NAMES)
  const implementation = randomFrom(OBFUSCATED_IMPLEMENTATIONS)
  const repository = randomFrom(OBFUSCATED_REPOSITORIES)
  const headBranch = randomFrom(OBFUSCATED_HEAD_BRANCHES)
  const ttlSeconds = randomFrom(OBFUSCATED_TTLS)
  const nowIso = formatIso(new Date())
  const sessionEvents: readonly SessionEvent[] = [
    {
      event: 'event_msg.agent_message',
      message: `Reconciling AgentRun/${run} (apiVersion=agents.proompteng.ai/v1alpha1, kind=AgentRun).`,
    },
    {
      event: 'response_item.function_call',
      message: `exec_command(cmd="kubectl -n ${namespace} get agentrun ${run} -o jsonpath='{.spec.agentRef.name} {.spec.runtime.type} {.spec.implementationSpecRef.name}'")`,
    },
    {
      event: 'response_item.function_call_output',
      message: `spec.agentRef.name=${agentName} spec.runtime.type=workflow spec.implementationSpecRef.name=${implementation}`,
    },
    {
      event: 'response_item.function_call',
      message: `exec_command(cmd="kubectl -n ${namespace} get agentrun ${run} -o jsonpath='{.status.phase} {.status.conditions[?(@.type=="Accepted")].reason}'")`,
    },
    {
      event: 'response_item.function_call_output',
      message: 'status.phase=Running status.conditions[Accepted]=True(Submitted)',
    },
    {
      event: 'response_item.function_call_output',
      message: `status.runtimeRef={type:workflow,name:${run}-plan-a1,namespace:${namespace}}`,
    },
    {
      event: 'response_item.function_call_output',
      message:
        'status.workflow.steps[0]={name:plan,attempt:1,phase:Succeeded} status.workflow.steps[1]={name:implement,attempt:1,phase:Running}',
    },
    {
      event: 'response_item.function_call_output',
      message: `status.contract.requiredKeys=[repository,base,head] status.contract.missingKeys=[] spec.ttlSecondsAfterFinished=${ttlSeconds}`,
    },
    {
      event: 'response_item.function_call_output',
      message: `status.vcs={provider:github,mode:read-write,repository:${repository},headBranch:${headBranch}}`,
    },
    {
      event: 'event_msg.agent_message',
      message: `status.phase=Succeeded status.conditions[Succeeded]=True(Completed) status.finishedAt=${nowIso}`,
    },
    {
      event: 'response_item.message.assistant',
      message: `tracked label agents.proompteng.ai/agent-run=${run}; workflow.phase=Succeeded`,
    },
    {
      event: 'event_msg.agent_reasoning',
      message: `retention: applying ttlSecondsAfterFinished=${ttlSeconds} to completed workflow jobs`,
      level: 'WARN',
    },
  ]
  const item = sessionEvents[index % sessionEvents.length] ?? sessionEvents[0]
  const level = item?.level ?? 'INFO'

  return mkRow(`log-${Date.now()}-${index}`, [
    { text: formatTime(new Date()), className: 'text-[rgb(var(--terminal-text-faint)/0.45)]' },
    { text: '  ' },
    {
      text: pad(level, 5),
      className:
        level === 'ERROR'
          ? 'text-[rgb(var(--terminal-text-red))]'
          : level === 'WARN'
            ? 'text-[rgb(var(--terminal-text-orange))]'
            : 'text-[rgb(var(--terminal-text-green))]',
    },
    { text: '  ' },
    { text: pad(item.event, 36), className: 'text-[rgb(var(--terminal-text-blue))]' },
    { text: '  ' },
    { text: item.message, className: 'text-[rgb(var(--terminal-text-primary)/0.82)]' },
  ])
}

function clamp(value: number, min: number, max: number) {
  return Math.min(Math.max(value, min), max)
}

function pad(text: string, width: number) {
  return text.length >= width ? `${text.slice(0, Math.max(0, width - 1))}\u2026` : text.padEnd(width)
}

function getViewport(bounds?: HTMLElement | null) {
  if (typeof window === 'undefined') {
    return FALLBACK_VIEWPORT
  }

  if (bounds) {
    const rect = bounds.getBoundingClientRect()
    return { width: rect.width, height: rect.height, left: rect.left, top: rect.top }
  }

  return { width: window.innerWidth, height: window.innerHeight, left: 0, top: 0 }
}

function formatSessionHeader() {
  const cols = [pad('TIME', 10), pad('EVENT', 36), 'MESSAGE']
  return cols.join('  ')
}

function formatSessionRow(input: { time: string; event: string; message: string }) {
  const cols = [pad(input.time, 10), pad(input.event, 36), input.message]
  return cols.join('  ')
}

function createInitialOutputRows(prefix: string): Row[] {
  return [
    mkRow(`${prefix}-header`, [
      { text: formatSessionHeader(), className: 'text-[rgb(var(--terminal-text-faint)/0.65)]' },
    ]),
    ...INITIAL_TRANSCRIPT.map((item, index) =>
      mkRow(`${prefix}-${index}`, [
        {
          text: formatSessionRow(item),
          className: 'text-[rgb(var(--terminal-text-primary)/0.82)]',
        },
      ]),
    ),
  ]
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
  desktopBoundsRef?: React.RefObject<HTMLElement | null>
  menuBarButtonRef?: React.RefObject<HTMLElement | null>
  onMinimizedStateChange?: (isMinimized: boolean) => void
  onClosedStateChange?: (isClosed: boolean) => void
}

const TerminalWindow = forwardRef<TerminalWindowHandle, TerminalWindowProps>(
  ({ className, desktopBoundsRef, menuBarButtonRef, onMinimizedStateChange, onClosedStateChange }, ref) => {
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
      const handleResize = () => setViewport(getViewport(desktopBoundsRef?.current))
      handleResize()
      window.addEventListener('resize', handleResize)
      return () => {
        window.removeEventListener('resize', handleResize)
      }
    }, [desktopBoundsRef])

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
      const topInsetPx = desktopBoundsRef?.current ? viewport.top : TOP_MENU_BAR_HEIGHT_PX
      const isFullscreenLike = fullscreenMode === 'fullscreen'
      const windowCenterX = viewport.left + viewport.width / 2 + (isFullscreenLike ? 0 : offset.x)
      const windowCenterY = viewport.top + viewport.height / 2 + (isFullscreenLike ? topInsetPx / 2 : offset.y)
      return {
        x: menuBarRect.left + menuBarRect.width / 2 - windowCenterX,
        y: menuBarRect.top + menuBarRect.height / 2 - windowCenterY,
      }
    }, [
      desktopBoundsRef,
      fullscreenMode,
      menuBarButtonRef,
      offset.x,
      offset.y,
      viewport.height,
      viewport.left,
      viewport.top,
      viewport.width,
    ])

    const getMinimizeTargetFallback = useCallback(() => {
      // If we can't measure the dock icon, still minimize to the dock area (bottom-center).
      // This avoids "minimize does nothing" when refs aren't available yet (SSR/fast interactions).
      const topInsetPx = desktopBoundsRef?.current ? viewport.top : TOP_MENU_BAR_HEIGHT_PX
      const isFullscreenLike = fullscreenMode === 'fullscreen'
      const windowCenterX = viewport.left + viewport.width / 2 + (isFullscreenLike ? 0 : offset.x)
      const windowCenterY = viewport.top + viewport.height / 2 + (isFullscreenLike ? topInsetPx / 2 : offset.y)

      const dockCenterX = viewport.left + viewport.width / 2
      const dockCenterY = viewport.top + viewport.height - 38
      return {
        x: dockCenterX - windowCenterX,
        y: dockCenterY - windowCenterY,
      }
    }, [
      desktopBoundsRef,
      fullscreenMode,
      offset.x,
      offset.y,
      viewport.height,
      viewport.left,
      viewport.top,
      viewport.width,
    ])

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
          { text: 'AgentRun status stream', className: 'text-[rgb(var(--terminal-text-primary)/0.82)]' },
        ]),
        mkRow('boot-1', [
          { text: 'loading ', className: 'text-[rgb(var(--terminal-text-secondary)/0.72)]' },
          {
            text: 'charts/agents/crds/agents.proompteng.ai_agentruns.yaml ',
            className: 'text-[rgb(var(--terminal-text-blue))]',
          },
          { text: '... ok', className: 'text-[rgb(var(--terminal-text-green))]' },
        ]),
        mkRow('boot-2', [
          { text: 'schema ', className: 'text-[rgb(var(--terminal-text-secondary)/0.72)]' },
          {
            text: 'spec.agentRef + spec.runtime + status.phase/conditions ',
            className: 'text-[rgb(var(--terminal-text-primary)/0.82)]',
          },
          { text: '... ok', className: 'text-[rgb(var(--terminal-text-green))]' },
        ]),
        mkRow('boot-3', [
          { text: 'streaming ', className: 'text-[rgb(var(--terminal-text-secondary)/0.72)]' },
          {
            text: 'workflow steps + runtimeRef + contract/vcs status',
            className: 'text-[rgb(var(--terminal-text-primary)/0.82)]',
          },
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

        const viewportRect = {
          left: 0,
          top: 0,
          right: window.innerWidth,
          bottom: window.innerHeight,
          width: window.innerWidth,
          height: window.innerHeight,
        }
        const dragAreaRect = desktopBoundsRef?.current?.getBoundingClientRect() ?? viewportRect
        const windowRect = windowRef.current.getBoundingClientRect()

        const deltaX = clientX - dragRef.current.startX
        const deltaY = clientY - dragRef.current.startY
        const nextX = dragRef.current.startOffsetX + deltaX
        const nextY = dragRef.current.startOffsetY + deltaY

        const minX = dragAreaRect.left + MIN_VISIBLE_PX - viewportRect.width / 2 - windowRect.width / 2
        const maxX = dragAreaRect.right - MIN_VISIBLE_PX - viewportRect.width / 2 + windowRect.width / 2

        // Keep the window below the menu bar and above the dock region.
        const topBoundAbsY = desktopBoundsRef
          ? Math.max(dragAreaRect.top, TOP_MENU_BAR_HEIGHT_PX)
          : TOP_MENU_BAR_HEIGHT_PX
        const bottomBoundAbsY = dragAreaRect.bottom - DOCK_SAFE_AREA_PX
        const minY = topBoundAbsY + windowRect.height / 2 - viewportRect.height / 2
        const maxY = bottomBoundAbsY - windowRect.height / 2 - viewportRect.height / 2
        const clampedMinY = Math.min(minY, maxY)
        const clampedMaxY = Math.max(minY, maxY)

        setOffset({ x: clamp(nextX, minX, maxX), y: clamp(nextY, clampedMinY, clampedMaxY) })
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
    }, [desktopBoundsRef, endDrag])

    useEffect(() => {
      if (reducedMotion) {
        setPhase('output')
        setCommandText(COMMAND)
        setRows((prev) => [...createInitialOutputRows('out'), ...prev])
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
                setRows(createInitialOutputRows('out'))
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
    const hasDesktopBounds = Boolean(desktopBoundsRef?.current)
    const topInsetPx = hasDesktopBounds ? viewport.top : TOP_MENU_BAR_HEIGHT_PX
    const normalWidth = clamp(viewport.width * 0.95, MAX_WINDOW_WIDTH_PX / 4, MAX_WINDOW_WIDTH_PX)
    const normalHeight = clamp(viewport.height * 0.82, 320, MAX_WINDOW_HEIGHT_PX)
    const isFullscreenTarget = fullscreenMode === 'fullscreen' || fullscreenMode === 'fullscreen-entering'
    const fullscreenBottomInsetPx = DOCK_SAFE_AREA_PX
    const fullscreenHeight = Math.max(
      260,
      hasDesktopBounds
        ? viewport.height - fullscreenBottomInsetPx
        : viewport.height - TOP_MENU_BAR_HEIGHT_PX - fullscreenBottomInsetPx,
    )
    const fullscreenY = isFullscreenTarget ? topInsetPx / 2 - fullscreenBottomInsetPx / 2 : 0
    const currentBaseX = isFullscreenTarget ? 0 : offset.x
    const currentBaseY = isFullscreenTarget ? fullscreenY : offset.y
    const targetWindowX = isFullscreenTarget ? 0 : offset.x
    const targetWindowY = isFullscreenTarget ? fullscreenY : offset.y
    const targetWindowWidth = isFullscreenTarget ? viewport.width : normalWidth
    const targetWindowHeight = isFullscreenTarget ? fullscreenHeight : normalHeight
    const targetBaseX = isMenuTargeting ? currentBaseX + minimizeOffset.x : currentBaseX
    const targetBaseY = isMenuTargeting ? currentBaseY + minimizeOffset.y : currentBaseY

    const windowAnimate = useMemo(() => {
      if (windowMode === 'minimizing') {
        return {
          x: targetBaseX,
          y: targetBaseY + 4,
          width: targetWindowWidth,
          height: targetWindowHeight,
          scaleX: MINIMIZE_SCALE,
          scaleY: MINIMIZE_SCALE * 0.96,
          opacity: 0,
        }
      }

      if (windowMode === 'minimized') {
        return {
          x: targetBaseX,
          y: targetBaseY + 4,
          width: targetWindowWidth,
          height: targetWindowHeight,
          scaleX: MINIMIZE_SCALE,
          scaleY: MINIMIZE_SCALE * 0.96,
          opacity: 0,
        }
      }

      if (windowMode === 'restoring') {
        return {
          x: currentBaseX,
          y: currentBaseY,
          width: targetWindowWidth,
          height: targetWindowHeight,
          scaleX: 1,
          scaleY: 1,
          opacity: 1,
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
      }
    }, [
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
          x: { type: 'tween', duration: MINIMIZE_DURATION, ease: MINIMIZE_EASE },
          y: { type: 'tween', duration: MINIMIZE_DURATION, ease: MINIMIZE_EASE },
          scaleX: { type: 'tween', duration: MINIMIZE_DURATION, ease: MINIMIZE_EASE },
          scaleY: { type: 'tween', duration: MINIMIZE_DURATION, ease: MINIMIZE_EASE },
          opacity: { type: 'tween', duration: MINIMIZE_DURATION * 0.82, ease: MINIMIZE_EASE },
          width: { type: 'tween', duration: 0.0001 },
          height: { type: 'tween', duration: 0.0001 },
        }
      }

      if (windowMode === 'restoring') {
        return {
          x: RESTORE_SPRING,
          y: RESTORE_SPRING,
          width: RESTORE_SPRING,
          height: RESTORE_SPRING,
          scaleX: RESTORE_SPRING,
          scaleY: RESTORE_SPRING,
          opacity: { type: 'tween', duration: 0.18, ease: [0.12, 0.88, 0.2, 1] as const },
        }
      }

      if (fullscreenMode === 'fullscreen-entering' || fullscreenMode === 'fullscreen-exiting') {
        return {
          x: FULLSCREEN_SPRING,
          y: FULLSCREEN_SPRING,
          width: FULLSCREEN_SPRING,
          height: FULLSCREEN_SPRING,
          scaleX: FULLSCREEN_SPRING,
          scaleY: FULLSCREEN_SPRING,
          opacity: { type: 'tween', duration: 0.16, ease: [0.2, 0.8, 0.2, 1] as const },
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
          'pointer-events-none fixed z-50 terminal-squircle-shell overflow-hidden left-1/2 top-1/2',
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
            'touch-none bg-[rgb(var(--terminal-titlebar-bg)/0.72)] border-[color:rgb(var(--terminal-shell-border)/0.38)]',
            'select-none text-left outline-none',
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
          onDoubleClick={(event) => {
            event.preventDefault()
            if (isControlLocked) return
            toggleFullscreen()
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
              className="relative size-[14px] shrink-0"
            >
              <svg
                viewBox="0 0 85.4 85.4"
                className="absolute inset-0 size-[14px] opacity-100 transition-opacity duration-150 group-hover/stoplights:opacity-0"
                aria-hidden="true"
              >
                <g clipRule="evenodd" fillRule="evenodd">
                  <path
                    d="m42.7 85.4c23.6 0 42.7-19.1 42.7-42.7s-19.1-42.7-42.7-42.7-42.7 19.1-42.7 42.7 19.1 42.7 42.7 42.7z"
                    fill="#d1d0d2"
                  />
                  <path
                    d="m42.7 81.7c21.6 0 39.1-17.5 39.1-39.1s-17.5-39.1-39.1-39.1-39.1 17.5-39.1 39.1 17.5 39.1 39.1 39.1z"
                    fill="#c7c7c7"
                  />
                </g>
              </svg>
              <svg
                viewBox="0 0 85.4 85.4"
                className="absolute inset-0 size-[14px] opacity-0 transition-opacity duration-150 group-hover/stoplights:opacity-100"
                aria-hidden="true"
              >
                <g clipRule="evenodd" fillRule="evenodd">
                  <path
                    d="m42.7 85.4c23.6 0 42.7-19.1 42.7-42.7s-19.1-42.7-42.7-42.7-42.7 19.1-42.7 42.7 19.1 42.7 42.7 42.7z"
                    fill="#e24b41"
                  />
                  <path
                    d="m42.7 81.8c21.6 0 39.1-17.5 39.1-39.1s-17.5-39.1-39.1-39.1-39.1 17.5-39.1 39.1 17.5 39.1 39.1 39.1z"
                    fill="#ed6a5f"
                  />
                  <g fill="#460804">
                    <path d="m22.5 57.8 35.3-35.3c1.4-1.4 3.6-1.4 5 0l.1.1c1.4 1.4 1.4 3.6 0 5l-35.3 35.3c-1.4 1.4-3.6 1.4-5 0l-.1-.1c-1.3-1.4-1.3-3.6 0-5z" />
                    <path d="m27.6 22.5 35.3 35.3c1.4 1.4 1.4 3.6 0 5l-.1.1c-1.4 1.4-3.6 1.4-5 0l-35.3-35.3c-1.4-1.4-1.4-3.6 0-5l.1-.1c1.4-1.3 3.6-1.3 5 0z" />
                  </g>
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
              className={cn('relative size-[14px] shrink-0', isControlLocked ? 'pointer-events-none' : '')}
            >
              <svg
                viewBox="0 0 85.4 85.4"
                className="absolute inset-0 size-[14px] opacity-100 transition-opacity duration-150 group-hover/stoplights:opacity-0"
                aria-hidden="true"
              >
                <g clipRule="evenodd" fillRule="evenodd">
                  <path
                    d="m42.7 85.4c23.6 0 42.7-19.1 42.7-42.7s-19.1-42.7-42.7-42.7-42.7 19.1-42.7 42.7 19.1 42.7 42.7 42.7z"
                    fill="#d1d0d2"
                  />
                  <path
                    d="m42.7 81.7c21.6 0 39.1-17.5 39.1-39.1s-17.5-39.1-39.1-39.1-39.1 17.5-39.1 39.1 17.5 39.1 39.1 39.1z"
                    fill="#c7c7c7"
                  />
                </g>
              </svg>
              <svg
                viewBox="0 0 85.4 85.4"
                className="absolute inset-0 size-[14px] opacity-0 transition-opacity duration-150 group-hover/stoplights:opacity-100"
                aria-hidden="true"
              >
                <g clipRule="evenodd" fillRule="evenodd">
                  <path
                    d="m42.7 85.4c23.6 0 42.7-19.1 42.7-42.7s-19.1-42.7-42.7-42.7-42.7 19.1-42.7 42.7 19.1 42.7 42.7 42.7z"
                    fill="#e1a73e"
                  />
                  <path
                    d="m42.7 81.8c21.6 0 39.1-17.5 39.1-39.1s-17.5-39.1-39.1-39.1-39.1 17.5-39.1 39.1 17.5 39.1 39.1 39.1z"
                    fill="#f6be50"
                  />
                  <path
                    d="m17.8 39.1h49.9c1.9 0 3.5 1.6 3.5 3.5v.1c0 1.9-1.6 3.5-3.5 3.5h-49.9c-1.9 0-3.5-1.6-3.5-3.5v-.1c0-1.9 1.5-3.5 3.5-3.5z"
                    fill="#90591d"
                  />
                </g>
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
              className={cn('relative size-[14px] shrink-0', isControlLocked ? 'pointer-events-none' : '')}
            >
              <svg
                viewBox="0 0 85.4 85.4"
                className="absolute inset-0 size-[14px] opacity-100 transition-opacity duration-150 group-hover/stoplights:opacity-0"
                aria-hidden="true"
              >
                <g clipRule="evenodd" fillRule="evenodd">
                  <path
                    d="m42.7 85.4c23.6 0 42.7-19.1 42.7-42.7s-19.1-42.7-42.7-42.7-42.7 19.1-42.7 42.7 19.1 42.7 42.7 42.7z"
                    fill="#d1d0d2"
                  />
                  <path
                    d="m42.7 81.7c21.6 0 39.1-17.5 39.1-39.1s-17.5-39.1-39.1-39.1-39.1 17.5-39.1 39.1 17.5 39.1 39.1 39.1z"
                    fill="#c7c7c7"
                  />
                </g>
              </svg>
              <svg
                viewBox="0 0 85.4 85.4"
                className="absolute inset-0 size-[14px] opacity-0 transition-opacity duration-150 group-hover/stoplights:opacity-100"
                aria-hidden="true"
              >
                <g clipRule="evenodd" fillRule="evenodd">
                  <path
                    d="m42.7 85.4c23.6 0 42.7-19.1 42.7-42.7s-19.1-42.7-42.7-42.7-42.7 19.1-42.7 42.7 19.1 42.7 42.7 42.7z"
                    fill="#2dac2f"
                  />
                  <path
                    d="m42.7 81.8c21.6 0 39.1-17.5 39.1-39.1s-17.5-39.1-39.1-39.1-39.1 17.5-39.1 39.1c0 21.5 17.5 39.1 39.1 39.1z"
                    fill="#61c555"
                  />
                  <path
                    d="m31.2 20.8h26.7c3.6 0 6.5 2.9 6.5 6.5v26.7zm23.2 43.7h-26.8c-3.6 0-6.5-2.9-6.5-6.5v-26.8z"
                    fill="#2a6218"
                    transform="translate(85.4 0) scale(-1 1)"
                  />
                </g>
              </svg>
            </button>
          </div>
          <div className="min-w-0">
            <p className="font-display truncate text-center text-sm font-medium tracking-[0.01em] text-[rgb(var(--terminal-titlebar-text))]">
              landing
            </p>
          </div>
          <div className="w-10" />
        </div>

        <div className="relative z-0 h-full overflow-hidden pt-10">
          <div
            className={cn(
              'relative h-full overflow-auto px-5 py-4 text-[12.5px] leading-relaxed sm:text-[13.5px]',
              'cursor-text select-text',
              'bg-[linear-gradient(180deg,rgb(var(--terminal-window-bg-top)/0.72),rgb(var(--terminal-window-bg-bottom)/0.54))]',
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
                <span className="text-[rgb(var(--terminal-text-blue))]">agents-controller</span>
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
