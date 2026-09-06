'use client'

import { motion, useMotionValue, useMotionValueEvent, useSpring, useTransform } from 'motion/react'
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
  setMagnificationLimit: (limit: number) => void
  setOffset: (offset: number) => void
  setPointerDistance: (distance: number | null) => void
}

type DockItemProps = {
  app: TengriApp
  motionDisabled: boolean
  onOpenApp: (app: TengriApp) => void
  onScaleChange: (app: TengriApp, scale: number) => void
  running: boolean
}

type DockGeometry = {
  centerX: number
}

const DockItem = forwardRef<DockItemHandle, DockItemProps>(function DockItem(
  { app, motionDisabled, onOpenApp, onScaleChange, running },
  ref,
) {
  const buttonRef = useRef<HTMLButtonElement | null>(null)
  const interactionRef = useRef<{ focused: boolean; pointerDistance: number | null }>({
    focused: false,
    pointerDistance: null,
  })
  const targetScale = useMotionValue(BASE_SCALE)
  const offset = useMotionValue(0)
  const magnificationLimit = useRef(1)
  const targetLift = useMotionValue(0)
  const scale = useSpring(targetScale, MAGNIFICATION_SPRING)
  const lift = useSpring(targetLift, MAGNIFICATION_SPRING)
  const labelLift = useTransform(() => lift.get() - (scale.get() - BASE_SCALE) * 56)
  const hitWidth = useTransform(scale, (value) => value * 56)
  useMotionValueEvent(scale, 'change', (value) => onScaleChange(app, value))

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
    const scaleDelta =
      Math.max(proximity * MAX_SCALE_DELTA, focused ? FOCUS_SCALE_DELTA : 0) * magnificationLimit.current
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
      getBounds: () => {
        const bounds = buttonRef.current?.getBoundingClientRect()
        return bounds ? new DOMRect(bounds.x - offset.get(), bounds.y, bounds.width, bounds.height) : null
      },
      setMagnificationLimit: (limit) => {
        magnificationLimit.current = limit
        applyInteraction()
      },
      setOffset: (value) => offset.set(value),
      setPointerDistance,
    }),
    [applyInteraction, offset, setPointerDistance],
  )

  return (
    <motion.button
      ref={buttonRef}
      id={`tengri-dock-${app}`}
      type="button"
      aria-label={`Open ${APP_TITLES[app]}`}
      className="group relative flex h-[68px] w-14 shrink-0 touch-manipulation items-center justify-center rounded-[14px] px-0 pb-1 outline-none transition-colors duration-150 focus-visible:bg-white/10 focus-visible:ring-2 focus-visible:ring-white/90 focus-visible:ring-offset-2 focus-visible:ring-offset-transparent motion-reduce:transition-none"
      style={{ x: offset }}
      onClick={() => onOpenApp(app)}
      onFocus={() => setFocused(true)}
      onBlur={() => setFocused(false)}
    >
      <motion.span
        aria-hidden="true"
        className="absolute inset-y-0 left-1/2 -translate-x-1/2"
        style={{ width: hitWidth }}
      />
      <motion.span
        aria-hidden="true"
        role="tooltip"
        className="pointer-events-none absolute bottom-full left-1/2 z-30 -translate-x-1/2 whitespace-nowrap rounded-[6px] border border-white/20 bg-[#303030]/90 px-2.5 py-1 text-[13px] leading-4 font-normal text-white/95 opacity-0 shadow-[0_3px_10px_rgba(0,0,0,0.3)] backdrop-blur-xl transition-opacity delay-0 duration-100 group-hover:delay-75 group-hover:opacity-100 group-focus-visible:opacity-100 motion-reduce:transition-none"
        style={{ y: labelLift }}
      >
        {APP_TITLES[app]}
        <span className="absolute top-[calc(100%-3px)] left-1/2 h-1.5 w-1.5 -translate-x-1/2 rotate-45 border-r border-b border-white/20 bg-[#303030]" />
      </motion.span>
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
    </motion.button>
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
  const scalesRef = useRef(new Map<TengriApp, number>())
  const dockWidthRef = useRef(1)
  const plateScale = useMotionValue(1)

  const arrangeItems = useCallback(
    (app: TengriApp, scale: number) => {
      scalesRef.current.set(app, scale)
      const widths = DOCK_APPS.map((item) => ((scalesRef.current.get(item) ?? BASE_SCALE) - BASE_SCALE) * 56)
      const expansion = widths.reduce((sum, width) => sum + width, 0)
      let preceding = 0
      DOCK_APPS.forEach((item, index) => {
        const width = widths[index] ?? 0
        itemHandlesRef.current.get(item)?.setOffset(preceding + width / 2 - expansion / 2)
        preceding += width
      })
      plateScale.set(1 + expansion / dockWidthRef.current)
    },
    [plateScale],
  )

  const registerItem = useCallback((app: TengriApp, handle: DockItemHandle | null) => {
    if (handle) itemHandlesRef.current.set(app, handle)
    else itemHandlesRef.current.delete(app)
  }, [])
  const items = useMemo(
    () => DOCK_APPS.map((app) => ({ app, ref: (handle: DockItemHandle | null) => registerItem(app, handle) })),
    [registerItem],
  )

  const measureGeometry = useCallback(() => {
    const dock = navRef.current?.getBoundingClientRect()
    if (!dock) return
    dockWidthRef.current = dock.width
    const available = Math.max(0, 2 * Math.min(dock.left - 8, window.innerWidth - dock.right - 8))
    const limit = Math.min(1, available / (DOCK_APPS.length * 56 * MAX_SCALE_DELTA))
    const nextGeometry = new Map<TengriApp, DockGeometry>()
    for (const app of DOCK_APPS) {
      const bounds = itemHandlesRef.current.get(app)?.getBounds()
      if (!bounds) continue
      nextGeometry.set(app, { centerX: bounds.left + bounds.width / 2 })
      itemHandlesRef.current.get(app)?.setMagnificationLimit(limit)
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
      className="pointer-events-auto relative flex h-[76px] max-w-[calc(100vw-1rem)] items-end justify-center gap-[clamp(0px,0.8vw,0.5rem)] overflow-visible rounded-[24px] border border-transparent px-[clamp(0.25rem,1.25vw,0.75rem)] pt-0 pb-1.5 touch-manipulation select-none"
      data-tengri-dock="true"
      onPointerEnter={handlePointerEnter}
      onPointerMove={updateProximity}
      onPointerLeave={resetProximity}
      onPointerCancel={resetProximity}
    >
      <motion.span
        aria-hidden="true"
        className="absolute -inset-px rounded-[24px] border border-white/25 bg-[rgba(31,35,49,0.46)] shadow-[0_12px_30px_rgba(0,0,0,0.34),inset_0_1px_0_rgba(255,255,255,0.2)] backdrop-blur-2xl backdrop-saturate-150"
        style={{ scaleX: plateScale }}
      >
        <span className="pointer-events-none absolute inset-x-5 top-px h-px rounded-full bg-gradient-to-r from-transparent via-white/35 to-transparent" />
      </motion.span>
      {items.map(({ app, ref }) => (
        <DockItem
          key={app}
          ref={ref}
          app={app}
          motionDisabled={motionDisabled}
          onOpenApp={onOpenApp}
          onScaleChange={arrangeItems}
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
