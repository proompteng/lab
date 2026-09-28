'use client'

import { motion } from 'motion/react'
import type { PointerEvent as ReactPointerEvent, ReactNode, RefObject } from 'react'
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { cn } from '@/lib/utils'
import { useDesktopReducedMotion } from './use-desktop-reduced-motion'
import { WindowControls } from './window-controls'
import { focusWindowContent, rememberWindowFocus } from './window-focus'
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
  pointerX: number
  pointerY: number
  base: Bounds
  next: Bounds
  viewport: Bounds
  frame: number | null
}

const RESIZE_GUTTER = 12

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
  const frameRef = useRef<HTMLElement | null>(null)
  const interactionRef = useRef<Interaction | null>(null)
  const releasePendingRef = useRef(false)
  const reducedMotion = useDesktopReducedMotion()
  const [minimizeTarget, setMinimizeTarget] = useState({ x: 0, y: 0, scale: 0.1 })

  useLayoutEffect(() => {
    if (!active || window.mode === 'minimized') return
    // Expose restored content before focusing; Motion paints its visible target on the next frame.
    if (elementRef.current) elementRef.current.style.visibility = 'visible'
    focusWindowContent(frameRef.current)
  }, [active, window.mode, window.z])

  useLayoutEffect(() => {
    if (window.mode !== 'minimized' || reducedMotion) return
    const dock = document.getElementById(`tengri-dock-${window.app}`)?.getBoundingClientRect()
    const stage = stageRef.current?.getBoundingClientRect()
    if (!dock || !stage) return
    setMinimizeTarget({
      x: dock.x + dock.width / 2 - stage.x - window.bounds.x - window.bounds.width / 2,
      y: dock.y + dock.height / 2 - stage.y - window.bounds.y - window.bounds.height / 2,
      scale: Math.min(dock.width / window.bounds.width, dock.height / window.bounds.height),
    })
  }, [reducedMotion, stageRef, window.app, window.bounds, window.mode])

  useEffect(
    () => () => {
      const interaction = interactionRef.current
      if (interaction?.frame != null) cancelAnimationFrame(interaction.frame)
      interactionRef.current = null
      resetTransientStyles(elementRef.current)
    },
    [],
  )

  useLayoutEffect(() => {
    if (!releasePendingRef.current) return
    releasePendingRef.current = false
    resetTransientStyles(elementRef.current)
  }, [window.bounds])

  const viewport = useCallback((): Bounds => {
    const rect = stageRef.current?.getBoundingClientRect()
    const browserWidth = typeof globalThis.window === 'undefined' ? 0 : globalThis.window.innerWidth
    const browserHeight =
      typeof globalThis.window === 'undefined' ? 0 : Math.max(0, globalThis.window.innerHeight - 126)
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
        pointerX: event.clientX,
        pointerY: event.clientY,
        base: window.bounds,
        next: window.bounds,
        viewport: viewport(),
        frame: null,
      }
      if (elementRef.current) elementRef.current.style.willChange = edge ? 'left, top, width, height' : 'translate'
    },
    [dispatch, viewport, window.bounds, window.id, window.mode],
  )

  const move = useCallback((event: ReactPointerEvent<HTMLElement>) => {
    const interaction = interactionRef.current
    if (!interaction || interaction.pointerId !== event.pointerId) return
    interaction.pointerX = event.clientX
    interaction.pointerY = event.clientY
    if (interaction.frame !== null) return
    interaction.frame = requestAnimationFrame(() => {
      interaction.frame = null
      updateInteractionBounds(interaction)
      const element = elementRef.current
      if (!element) return
      paintWindowInteractionFrame(element.style, interaction, RESIZE_GUTTER)
    })
  }, [])

  const end = useCallback(
    (event: ReactPointerEvent<HTMLElement>) => {
      const interaction = interactionRef.current
      if (!interaction || interaction.pointerId !== event.pointerId) return
      if (interaction.frame !== null) cancelAnimationFrame(interaction.frame)
      interaction.viewport = viewport()
      updateInteractionBounds(interaction)
      interaction.next = clampToViewport(interaction.next, interaction.viewport)
      const element = elementRef.current
      if (element) paintWindowInteractionFrame(element.style, interaction, RESIZE_GUTTER)
      interactionRef.current = null
      if (event.currentTarget.hasPointerCapture(event.pointerId)) {
        event.currentTarget.releasePointerCapture(event.pointerId)
      }
      if (element) element.style.willChange = ''
      releasePendingRef.current = true
      dispatch({ type: 'move', id: window.id, bounds: interaction.next })
    },
    [dispatch, viewport, window.id],
  )

  const bounds = window.bounds
  const unifiedToolbar = window.app === 'chrome' || window.app === 'finder' || window.app === 'settings'
  return (
    <motion.div
      ref={elementRef}
      className="absolute overflow-visible"
      initial={false}
      animate={
        window.mode === 'minimized'
          ? {
              opacity: 0,
              transform: reducedMotion
                ? 'translate(0px, 0px) scale(1)'
                : `translate(${minimizeTarget.x}px, ${minimizeTarget.y}px) scale(${minimizeTarget.scale})`,
              pointerEvents: 'none',
              transitionEnd: { visibility: 'hidden' },
            }
          : { opacity: 1, transform: 'translate(0px, 0px) scale(1)', pointerEvents: 'auto', visibility: 'visible' }
      }
      transition={reducedMotion ? { duration: 0 } : { type: 'spring', stiffness: 440, damping: 38, mass: 0.8 }}
      style={{
        left: bounds.x - RESIZE_GUTTER,
        top: bounds.y - RESIZE_GUTTER,
        width: bounds.width + RESIZE_GUTTER * 2,
        height: bounds.height + RESIZE_GUTTER * 2,
        zIndex: window.z,
      }}
    >
      <section
        ref={frameRef}
        tabIndex={-1}
        data-window-id={window.id}
        aria-label={`${window.title} window`}
        aria-hidden={window.mode === 'minimized'}
        inert={window.mode === 'minimized' ? true : undefined}
        data-active={active}
        data-app={window.app}
        className={cn(
          'tengri-window absolute inset-3 flex flex-col overflow-hidden rounded-xl bg-zinc-900 outline-none ring-1 ring-black/55 before:pointer-events-none before:absolute before:inset-0 before:z-40 before:rounded-[inherit] before:shadow-[inset_0_0_0_1px_rgba(255,255,255,0.16)]',
          active
            ? 'shadow-[0_20px_48px_-12px_rgba(0,0,0,0.52),0_4px_14px_rgba(0,0,0,0.24)]'
            : 'shadow-[0_7px_22px_-6px_rgba(0,0,0,0.3)]',
        )}
        style={{ pointerEvents: window.mode === 'minimized' ? 'none' : 'auto' }}
        onFocusCapture={(event) => {
          rememberWindowFocus(event.currentTarget, event.target)
          if (!active) dispatch({ type: 'focus', id: window.id })
        }}
        onPointerDown={(event) => {
          if (window.mode === 'normal' && isWindowDragTarget(event.target)) begin(event, null)
          else dispatch({ type: 'focus', id: window.id })
        }}
        onDoubleClick={(event) => {
          if (isWindowDragTarget(event.target)) {
            dispatch({ type: 'toggle-maximize', id: window.id, viewport: viewport() })
          }
        }}
        onPointerMove={move}
        onPointerUp={end}
        onPointerCancel={end}
      >
        <header
          data-window-drag-region
          className={cn(
            'flex shrink-0 touch-none select-none items-center px-2.5',
            unifiedToolbar
              ? `pointer-events-none absolute inset-x-0 top-0 z-10 ${window.app === 'chrome' ? 'h-10' : 'h-[52px]'}`
              : 'relative h-9 border-b border-black/25 bg-gradient-to-b from-[#38383b] to-[#303033]',
          )}
        >
          <WindowControls
            active={active}
            maximized={window.mode === 'maximized'}
            onClose={onCloseRequest ?? (() => dispatch({ type: 'close', id: window.id }))}
            onMinimize={() => dispatch({ type: 'minimize', id: window.id })}
            onToggleMaximize={() => dispatch({ type: 'toggle-maximize', id: window.id, viewport: viewport() })}
            title={window.title}
          />
          <h2
            className={
              unifiedToolbar
                ? 'sr-only'
                : `pointer-events-none absolute inset-x-28 truncate text-center text-[13px] font-semibold ${active ? 'text-white/88' : 'text-white/48'}`
            }
          >
            {window.title}
          </h2>
        </header>
        <div className="min-h-0 flex-1 overflow-hidden">{children}</div>
      </section>
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
    </motion.div>
  )
}

function isWindowDragTarget(target: EventTarget | null) {
  return (
    target instanceof Element &&
    Boolean(target.closest('[data-window-drag-region]')) &&
    !target.closest('button, input, label, textarea, select, a, [role="button"], [contenteditable="true"]')
  )
}

export function paintWindowInteractionFrame(
  style: Pick<CSSStyleDeclaration, 'height' | 'left' | 'top' | 'translate' | 'width'>,
  interaction: Pick<Interaction, 'base' | 'edge' | 'next'>,
  gutter = 0,
) {
  if (!interaction.edge) {
    const translateX = interaction.next.x - interaction.base.x
    const translateY = interaction.next.y - interaction.base.y
    style.translate = `${translateX}px ${translateY}px`
    return
  }
  style.left = `${interaction.next.x - gutter}px`
  style.top = `${interaction.next.y - gutter}px`
  style.width = `${interaction.next.width + gutter * 2}px`
  style.height = `${interaction.next.height + gutter * 2}px`
}

function updateInteractionBounds(interaction: Interaction) {
  const dx = interaction.pointerX - interaction.startX
  const dy = interaction.pointerY - interaction.startY
  interaction.next = interaction.edge
    ? resizeBounds(interaction.base, interaction.edge, dx, dy, interaction.viewport)
    : clampToViewport(
        { ...interaction.base, x: interaction.base.x + dx, y: interaction.base.y + dy },
        interaction.viewport,
      )
}

function resetTransientStyles(element: HTMLDivElement | null) {
  if (!element) return
  element.style.removeProperty('translate')
  element.style.willChange = ''
}

function resizeHandleClass(edge: ResizeEdge) {
  const shared = 'z-20 touch-none'
  const classes: Record<ResizeEdge, string> = {
    n: 'top-0 left-3 right-3 h-3 cursor-n-resize',
    s: 'bottom-0 left-3 right-3 h-3 cursor-s-resize',
    e: 'top-3 right-0 bottom-3 w-3 cursor-e-resize',
    w: 'top-3 bottom-3 left-0 w-3 cursor-w-resize',
    ne: 'top-0 right-0 h-6 w-6 cursor-ne-resize',
    nw: 'top-0 left-0 h-6 w-6 cursor-nw-resize',
    se: 'right-0 bottom-0 h-6 w-6 cursor-se-resize',
    sw: 'bottom-0 left-0 h-6 w-6 cursor-sw-resize',
  }
  return `${shared} ${classes[edge]}`
}
