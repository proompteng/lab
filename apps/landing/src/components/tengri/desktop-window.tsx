'use client'

import { motion, useReducedMotion } from 'motion/react'
import type { PointerEvent as ReactPointerEvent, ReactNode, RefObject } from 'react'
import { useCallback, useEffect, useRef } from 'react'
import {
  clampToViewport,
  resizeBounds,
  type Bounds,
  type DesktopWindow,
  type ResizeEdge,
  type WindowAction,
} from '@/lib/tengri/window-manager'

type Interaction = {
  pointerId: number
  edge: ResizeEdge | null
  startX: number
  startY: number
  base: Bounds
  next: Bounds
  frame: number | null
}

export function DesktopWindowFrame({
  active,
  children,
  dispatch,
  onCloseRequest,
  stageRef,
  window,
}: {
  active: boolean
  children: ReactNode
  dispatch: (action: WindowAction) => void
  onCloseRequest?: () => void
  stageRef: RefObject<HTMLDivElement | null>
  window: DesktopWindow
}) {
  const elementRef = useRef<HTMLDivElement | null>(null)
  const interactionRef = useRef<Interaction | null>(null)
  const reducedMotion = useReducedMotion()

  useEffect(
    () => () => {
      const interaction = interactionRef.current
      if (interaction?.frame != null) cancelAnimationFrame(interaction.frame)
      interactionRef.current = null
      resetTransientStyles(elementRef.current)
    },
    [],
  )

  const viewport = useCallback((): Bounds => {
    const rect = stageRef.current?.getBoundingClientRect()
    const browserWidth = typeof globalThis.window === 'undefined' ? 0 : globalThis.window.innerWidth
    const browserHeight = typeof globalThis.window === 'undefined' ? 0 : Math.max(0, globalThis.window.innerHeight - 28)
    return { x: 0, y: 0, width: rect?.width ?? browserWidth, height: rect?.height ?? browserHeight }
  }, [stageRef])

  const begin = useCallback(
    (event: ReactPointerEvent<HTMLElement>, edge: ResizeEdge | null) => {
      if (window.mode !== 'normal' || event.button !== 0) return
      event.preventDefault()
      dispatch({ type: 'focus', id: window.id })
      event.currentTarget.setPointerCapture(event.pointerId)
      interactionRef.current = {
        pointerId: event.pointerId,
        edge,
        startX: event.clientX,
        startY: event.clientY,
        base: window.bounds,
        next: window.bounds,
        frame: null,
      }
      if (elementRef.current) elementRef.current.style.willChange = edge ? 'left, top, width, height' : 'transform'
    },
    [dispatch, window.bounds, window.id, window.mode],
  )

  const move = useCallback(
    (event: ReactPointerEvent<HTMLElement>) => {
      const interaction = interactionRef.current
      if (!interaction || interaction.pointerId !== event.pointerId) return
      const dx = event.clientX - interaction.startX
      const dy = event.clientY - interaction.startY
      interaction.next = interaction.edge
        ? resizeBounds(interaction.base, interaction.edge, dx, dy, viewport())
        : clampToViewport({ ...interaction.base, x: interaction.base.x + dx, y: interaction.base.y + dy }, viewport())
      if (interaction.frame !== null) return
      interaction.frame = requestAnimationFrame(() => {
        interaction.frame = null
        const element = elementRef.current
        if (!element) return
        paintWindowInteractionFrame(element.style, interaction)
      })
    },
    [viewport],
  )

  const end = useCallback(
    (event: ReactPointerEvent<HTMLElement>) => {
      const interaction = interactionRef.current
      if (!interaction || interaction.pointerId !== event.pointerId) return
      if (interaction.frame !== null) cancelAnimationFrame(interaction.frame)
      const element = elementRef.current
      if (element) paintWindowInteractionFrame(element.style, interaction)
      interactionRef.current = null
      if (event.currentTarget.hasPointerCapture(event.pointerId)) {
        event.currentTarget.releasePointerCapture(event.pointerId)
      }
      resetTransientStyles(elementRef.current)
      dispatch({ type: 'move', id: window.id, bounds: interaction.next })
    },
    [dispatch, window.id],
  )

  const bounds = window.bounds
  return (
    <motion.section
      ref={elementRef}
      aria-label={`${window.title} window`}
      aria-hidden={window.mode === 'minimized'}
      inert={window.mode === 'minimized' ? true : undefined}
      className="tengri-window absolute overflow-visible rounded-[22px] border border-white/20 bg-[rgba(20,22,28,0.91)] shadow-[0_38px_100px_rgba(0,0,0,0.48),inset_0_1px_0_rgba(255,255,255,0.16)] backdrop-blur-2xl [contain:layout]"
      initial={false}
      animate={
        window.mode === 'minimized'
          ? {
              opacity: 0,
              scale: reducedMotion ? 1 : 0.18,
              y: reducedMotion ? 0 : viewport().height * 0.52,
              pointerEvents: 'none',
            }
          : { opacity: 1, scale: 1, y: 0, pointerEvents: 'auto' }
      }
      transition={reducedMotion ? { duration: 0 } : { type: 'spring', stiffness: 440, damping: 38, mass: 0.8 }}
      style={{
        left: bounds.x,
        top: bounds.y,
        width: bounds.width,
        height: bounds.height,
        zIndex: window.z,
      }}
      onPointerDown={() => dispatch({ type: 'focus', id: window.id })}
    >
      <header
        className="flex h-11 touch-none items-center rounded-t-[21px] border-b border-white/10 bg-white/[0.045] px-4"
        onDoubleClick={() => dispatch({ type: 'toggle-maximize', id: window.id, viewport: viewport() })}
        onPointerDown={(event) => begin(event, null)}
        onPointerMove={move}
        onPointerUp={end}
        onPointerCancel={end}
      >
        <div className="flex items-center gap-2" aria-label="Window controls">
          <button
            type="button"
            aria-label={`Close ${window.title}`}
            className="group grid h-6 w-6 place-items-center rounded-full"
            onPointerDown={(event) => event.stopPropagation()}
            onClick={() => (onCloseRequest ? onCloseRequest() : dispatch({ type: 'close', id: window.id }))}
          >
            <span
              aria-hidden="true"
              className="h-3.5 w-3.5 rounded-full border border-black/20 bg-[#ff5f57] shadow-inner"
            />
          </button>
          <button
            type="button"
            aria-label={`Minimize ${window.title}`}
            className="group grid h-6 w-6 place-items-center rounded-full"
            onPointerDown={(event) => event.stopPropagation()}
            onClick={() => dispatch({ type: 'minimize', id: window.id })}
          >
            <span
              aria-hidden="true"
              className="h-3.5 w-3.5 rounded-full border border-black/20 bg-[#febc2e] shadow-inner"
            />
          </button>
          <button
            type="button"
            aria-label={`${window.mode === 'maximized' ? 'Restore' : 'Maximize'} ${window.title}`}
            className="group grid h-6 w-6 place-items-center rounded-full"
            onPointerDown={(event) => event.stopPropagation()}
            onClick={() => dispatch({ type: 'toggle-maximize', id: window.id, viewport: viewport() })}
          >
            <span
              aria-hidden="true"
              className="h-3.5 w-3.5 rounded-full border border-black/20 bg-[#28c840] shadow-inner"
            />
          </button>
        </div>
        <h2
          className={`pointer-events-none absolute inset-x-28 truncate text-center text-[13px] font-semibold ${active ? 'text-white/88' : 'text-white/48'}`}
        >
          {window.title}
        </h2>
      </header>
      <div className="h-[calc(100%-2.75rem)] min-h-0 overflow-hidden rounded-b-[21px]">{children}</div>
      {window.mode === 'normal'
        ? (['n', 's', 'e', 'w', 'ne', 'nw', 'se', 'sw'] as const).map((edge) => (
            <div
              key={edge}
              aria-hidden="true"
              className={`absolute ${resizeHandleClass(edge)}`}
              onPointerDown={(event) => begin(event, edge)}
              onPointerMove={move}
              onPointerUp={end}
              onPointerCancel={end}
            />
          ))
        : null}
    </motion.section>
  )
}

export function paintWindowInteractionFrame(
  style: Pick<CSSStyleDeclaration, 'height' | 'left' | 'top' | 'transform' | 'width'>,
  interaction: Pick<Interaction, 'base' | 'edge' | 'next'>,
) {
  if (!interaction.edge) {
    const translateX = interaction.next.x - interaction.base.x
    const translateY = interaction.next.y - interaction.base.y
    style.transform = `translate3d(${translateX}px, ${translateY}px, 0)`
    return
  }
  style.left = `${interaction.next.x}px`
  style.top = `${interaction.next.y}px`
  style.width = `${interaction.next.width}px`
  style.height = `${interaction.next.height}px`
}

function resetTransientStyles(element: HTMLDivElement | null) {
  if (!element) return
  element.style.transform = ''
  element.style.willChange = ''
}

function resizeHandleClass(edge: ResizeEdge) {
  const shared = 'z-20 touch-none'
  const classes: Record<ResizeEdge, string> = {
    n: '-top-2 left-3 right-3 h-2 cursor-n-resize',
    s: '-bottom-2 left-3 right-3 h-2 cursor-s-resize',
    e: 'top-3 -right-2 bottom-3 w-2 cursor-e-resize',
    w: 'top-3 bottom-3 -left-2 w-2 cursor-w-resize',
    ne: '-top-2 -right-2 h-3 w-3 cursor-ne-resize',
    nw: '-top-2 -left-2 h-3 w-3 cursor-nw-resize',
    se: '-right-2 -bottom-2 h-3 w-3 cursor-se-resize',
    sw: '-bottom-2 -left-2 h-3 w-3 cursor-sw-resize',
  }
  return `${shared} ${classes[edge]}`
}
