'use client'

import { motion, useMotionValue, useSpring } from 'motion/react'
import type { PointerEvent as ReactPointerEvent } from 'react'
import { forwardRef, useCallback, useImperativeHandle, useLayoutEffect, useMemo, useRef } from 'react'

import { APP_TITLES } from '@/lib/tengri/window-manager'
import type { DesktopWindow, TengriApp } from '@/lib/tengri/window-manager'
import { cn } from '@/lib/utils'

import { DesktopAppIcon } from './desktop-app-icon'
import { DOCK_APPS } from './desktop-apps'
import { useDesktopReducedMotion } from './use-desktop-reduced-motion'

const BASE_SCALE = 1
const MAX_SCALE_DELTA = 0.38
const MAX_LIFT = 14
const MAGNIFICATION_RADIUS = 124
const FOCUS_SCALE_DELTA = 0.08
const FOCUS_LIFT = 4
const MAGNIFICATION_SPRING = { damping: 30, mass: 0.45, stiffness: 460 }

type DockItemHandle = {
  getBounds: () => DOMRect | null
  setFocused: (focused: boolean) => void
  setPointerDistance: (distance: number | null) => void
}

type DockItemProps = {
  app: TengriApp
  motionDisabled: boolean
  onOpenApp: (app: TengriApp) => void
  running: boolean
}

type DockGeometry = {
  centerX: number
}

const DockItem = forwardRef<DockItemHandle, DockItemProps>(function DockItem(
  { app, motionDisabled, onOpenApp, running },
  ref,
) {
  const buttonRef = useRef<HTMLButtonElement | null>(null)
  const interactionRef = useRef<{ focused: boolean; pointerDistance: number | null }>({
    focused: false,
    pointerDistance: null,
  })
  const targetScale = useMotionValue(BASE_SCALE)
  const targetLift = useMotionValue(0)
  const scale = useSpring(targetScale, MAGNIFICATION_SPRING)
  const lift = useSpring(targetLift, MAGNIFICATION_SPRING)

  const applyInteraction = useCallback(() => {
    if (motionDisabled) {
      targetScale.jump(BASE_SCALE)
      targetLift.jump(0)
      scale.jump(BASE_SCALE)
      lift.jump(0)
      return
    }

    const { focused, pointerDistance } = interactionRef.current
    const proximity =
      pointerDistance === null ? 0 : smoothStep(clamp(1 - Math.abs(pointerDistance) / MAGNIFICATION_RADIUS, 0, 1))
    const scaleDelta = Math.max(proximity * MAX_SCALE_DELTA, focused ? FOCUS_SCALE_DELTA : 0)
    const liftDistance = Math.max(proximity * MAX_LIFT, focused ? FOCUS_LIFT : 0)
    targetScale.set(BASE_SCALE + scaleDelta)
    targetLift.set(-liftDistance)
  }, [lift, motionDisabled, scale, targetLift, targetScale])

  const setFocused = useCallback(
    (focused: boolean) => {
      interactionRef.current.focused = focused
      applyInteraction()
    },
    [applyInteraction],
  )

  const setPointerDistance = useCallback(
    (distance: number | null) => {
      interactionRef.current.pointerDistance = distance
      applyInteraction()
    },
    [applyInteraction],
  )

  useLayoutEffect(() => {
    applyInteraction()
  }, [applyInteraction])

  useImperativeHandle(
    ref,
    () => ({
      getBounds: () => buttonRef.current?.getBoundingClientRect() ?? null,
      setFocused,
      setPointerDistance,
    }),
    [setFocused, setPointerDistance],
  )

  return (
    <button
      ref={buttonRef}
      id={`tengri-dock-${app}`}
      type="button"
      aria-label={`Open ${APP_TITLES[app]}`}
      className="group relative flex h-[68px] w-14 shrink-0 touch-manipulation items-center justify-center rounded-[14px] px-0 pb-1 outline-none transition-colors duration-150 focus-visible:bg-white/10 focus-visible:ring-2 focus-visible:ring-white/90 focus-visible:ring-offset-2 focus-visible:ring-offset-transparent motion-reduce:transition-none"
      onClick={() => onOpenApp(app)}
      onFocus={() => setFocused(true)}
      onBlur={() => setFocused(false)}
    >
      <span
        aria-hidden="true"
        role="tooltip"
        className="pointer-events-none absolute bottom-[calc(100%+2.125rem)] left-1/2 z-30 -translate-x-1/2 translate-y-1 whitespace-nowrap rounded-[9px] border border-white/20 bg-[rgba(26,30,44,0.88)] px-2.5 py-1 text-[12px] leading-4 font-medium tracking-[-0.01em] text-white/90 opacity-0 shadow-[0_8px_20px_rgba(0,0,0,0.32)] backdrop-blur-xl transition-[opacity,transform] delay-0 duration-150 ease-out group-hover:delay-75 group-hover:translate-y-0 group-hover:opacity-100 group-focus-visible:translate-y-0 group-focus-visible:opacity-100 motion-reduce:translate-y-0 motion-reduce:transition-none"
      >
        {APP_TITLES[app]}
      </span>
      <span
        aria-hidden="true"
        className="pointer-events-none absolute inset-x-0 top-1/2 grid h-14 w-14 -translate-y-[calc(50%-0.1875rem)] place-items-center"
      >
        <motion.span
          aria-hidden="true"
          className="grid h-14 w-14 shrink-0 place-items-center will-change-transform"
          style={{ y: lift, scale, transformOrigin: 'bottom center' }}
        >
          <DesktopAppIcon app={app} className="size-14" />
        </motion.span>
      </span>
      <span
        aria-hidden="true"
        className={cn(
          'pointer-events-none absolute inset-x-0 bottom-0 mx-auto h-1 w-1 rounded-full',
          running ? 'bg-white/90' : 'bg-transparent',
        )}
      />
    </button>
  )
})

export function DesktopDock({
  windows,
  onOpenApp,
}: {
  windows: readonly DesktopWindow[]
  onOpenApp: (app: TengriApp) => void
}) {
  const reducedMotion = useDesktopReducedMotion()
  const motionDisabled = reducedMotion === true
  const navRef = useRef<HTMLElement | null>(null)
  const itemHandlesRef = useRef(new Map<TengriApp, DockItemHandle>())
  const geometryRef = useRef(new Map<TengriApp, DockGeometry>())

  const registerItem = useCallback((app: TengriApp, handle: DockItemHandle | null) => {
    if (handle) itemHandlesRef.current.set(app, handle)
    else itemHandlesRef.current.delete(app)
  }, [])
  const items = useMemo(
    () => DOCK_APPS.map((app) => ({ app, ref: (handle: DockItemHandle | null) => registerItem(app, handle) })),
    [registerItem],
  )

  const measureGeometry = useCallback(() => {
    const nextGeometry = new Map<TengriApp, DockGeometry>()
    for (const app of DOCK_APPS) {
      const bounds = itemHandlesRef.current.get(app)?.getBounds()
      if (!bounds) continue
      nextGeometry.set(app, { centerX: bounds.left + bounds.width / 2 })
    }
    geometryRef.current = nextGeometry
  }, [])

  const resetProximity = useCallback(() => {
    for (const handle of itemHandlesRef.current.values()) handle.setPointerDistance(null)
  }, [])

  const updateProximity = useCallback(
    (event: ReactPointerEvent<HTMLElement>) => {
      if (motionDisabled || event.pointerType === 'touch') {
        resetProximity()
        return
      }

      if (geometryRef.current.size !== DOCK_APPS.length) measureGeometry()
      for (const app of DOCK_APPS) {
        const centerX = geometryRef.current.get(app)?.centerX
        itemHandlesRef.current.get(app)?.setPointerDistance(centerX === undefined ? null : event.clientX - centerX)
      }
    },
    [measureGeometry, motionDisabled, resetProximity],
  )

  const handlePointerEnter = useCallback(
    (event: ReactPointerEvent<HTMLElement>) => {
      measureGeometry()
      updateProximity(event)
    },
    [measureGeometry, updateProximity],
  )

  useLayoutEffect(() => {
    const nav = navRef.current
    if (!nav) return
    measureGeometry()
    const handleResize = () => measureGeometry()
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(handleResize)
    observer?.observe(nav)
    window.addEventListener('resize', handleResize)
    return () => {
      observer?.disconnect()
      window.removeEventListener('resize', handleResize)
    }
  }, [measureGeometry])

  const runningApps = new Set(windows.map((desktopWindow) => desktopWindow.app))
  return (
    <nav
      ref={navRef}
      aria-label="Dock"
      className="pointer-events-auto relative flex h-[76px] max-w-[calc(100vw-1rem)] items-end justify-center gap-[clamp(0px,0.8vw,0.5rem)] overflow-visible rounded-[24px] border border-white/25 bg-[rgba(31,35,49,0.46)] px-[clamp(0.25rem,1.25vw,0.75rem)] pt-0 pb-1.5 shadow-[0_12px_30px_rgba(0,0,0,0.34),inset_0_1px_0_rgba(255,255,255,0.2)] backdrop-blur-2xl backdrop-saturate-150 touch-manipulation select-none"
      data-tengri-dock="true"
      onPointerEnter={handlePointerEnter}
      onPointerMove={updateProximity}
      onPointerLeave={resetProximity}
      onPointerCancel={resetProximity}
    >
      <span
        aria-hidden="true"
        className="pointer-events-none absolute inset-x-5 top-px h-px rounded-full bg-gradient-to-r from-transparent via-white/35 to-transparent"
      />
      {items.map(({ app, ref }) => (
        <DockItem
          key={app}
          ref={ref}
          app={app}
          motionDisabled={motionDisabled}
          onOpenApp={onOpenApp}
          running={runningApps.has(app)}
        />
      ))}
    </nav>
  )
}

function clamp(value: number, minimum: number, maximum: number) {
  return Math.min(Math.max(value, minimum), maximum)
}

function smoothStep(value: number) {
  return value * value * (3 - 2 * value)
}
