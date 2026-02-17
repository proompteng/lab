'use client'

import { Wifi } from 'lucide-react'
import { AnimatePresence, motion, useAnimationControls, useAnimationFrame } from 'motion/react'
import Image from 'next/image'
import {
  type MutableRefObject,
  memo,
  type PointerEvent as ReactPointerEvent,
  type RefObject,
  useCallback,
  useEffect,
  useRef,
  useState,
} from 'react'

import TerminalWindow, { type TerminalWindowHandle } from '@/components/terminal-window'
import { cn } from '@/lib/utils'

type TopMenuItem = {
  id: string
  label: string
  action?: 'minimize' | 'restore' | 'toggle-fullscreen'
}

type TopMenuSection = {
  id: string
  label: string
  items: TopMenuItem[]
}

const topMenus: TopMenuSection[] = [
  {
    id: 'terminal',
    label: 'proompteng',
    items: [
      { id: 'about', label: 'About proompteng' },
      { id: 'about-window', label: 'About This Mac' },
      { id: 'preferences', label: 'Preferences…' },
      { id: 'services', label: 'Services' },
      { id: 'hide', label: 'Hide proompteng' },
      { id: 'hide-others', label: 'Hide Others' },
      { id: 'show-all', label: 'Show All' },
      { id: 'quit', label: 'Quit proompteng', action: 'minimize' },
    ],
  },
  {
    id: 'file',
    label: 'File',
    items: [
      { id: 'new', label: 'New Window' },
      { id: 'open', label: 'Open' },
      { id: 'close', label: 'Close Window', action: 'minimize' },
      { id: 'save', label: 'Save As…' },
    ],
  },
  {
    id: 'edit',
    label: 'Edit',
    items: [
      { id: 'undo', label: 'Undo' },
      { id: 'redo', label: 'Redo' },
      { id: 'cut', label: 'Cut' },
      { id: 'copy', label: 'Copy' },
      { id: 'paste', label: 'Paste' },
    ],
  },
  {
    id: 'view',
    label: 'View',
    items: [
      { id: 'as', label: 'Enter Full Screen', action: 'toggle-fullscreen' },
      { id: 'zoom-in', label: 'Zoom In' },
      { id: 'zoom-out', label: 'Zoom Out' },
      { id: 'toggle', label: 'Toggle Toolbar' },
    ],
  },
  {
    id: 'window',
    label: 'Window',
    items: [
      { id: 'minimize', label: 'Minimize', action: 'minimize' },
      { id: 'zoom', label: 'Zoom', action: 'toggle-fullscreen' },
      { id: 'arrange', label: 'Bring All to Front' },
    ],
  },
  {
    id: 'help',
    label: 'Help',
    items: [
      { id: 'help', label: 'Proompteng Help' },
      { id: 'release-notes', label: 'Release Notes' },
      { id: 'report', label: 'Report Issue…' },
    ],
  },
]

const DESKTOP_ITEMS = [
  { id: 'docs', label: 'Docs', emoji: '📘' },
  { id: 'app', label: 'Apps', emoji: '⚙️' },
  { id: 'root', label: 'System', emoji: '💻' },
] as const

const DOCK_ITEMS = [
  { id: 'docs', label: 'Docs', emoji: '📘', terminal: false },
  { id: 'terminal', label: 'proompteng', terminal: true },
  { id: 'mail', label: 'Mail', emoji: '✉️', terminal: false },
  { id: 'settings', label: 'Settings', emoji: '⚙️', terminal: false },
] as const

export default function DesktopHero() {
  const terminalWindowRef = useRef<TerminalWindowHandle>(null)
  const menuBarButtonRef = useRef<HTMLButtonElement>(null)
  const topMenuRef = useRef<HTMLDivElement>(null)
  const [currentTime, setCurrentTime] = useState('--:--')
  const [activeMenu, setActiveMenu] = useState<string | null>(null)
  const [isTerminalClosed, setIsTerminalClosed] = useState(false)

  const restoreWindow = useCallback(() => {
    terminalWindowRef.current?.restore()
  }, [])

  const handleDockClick = useCallback(() => {
    restoreWindow()
  }, [restoreWindow])

  const closeTopMenu = useCallback(() => {
    setActiveMenu(null)
  }, [])

  const toggleTopMenuAtButton = useCallback(
    (id: string) => {
      if (activeMenu === id) {
        closeTopMenu()
        return
      }
      setActiveMenu(id)
    },
    [activeMenu, closeTopMenu],
  )

  const openTopMenuAtButton = useCallback(
    (id: string) => {
      if (activeMenu === null) return
      setActiveMenu(id)
    },
    [activeMenu],
  )

  const runTopMenuAction = useCallback(
    (item: TopMenuItem) => {
      if (item.action === 'minimize') {
        terminalWindowRef.current?.minimize()
      } else if (item.action === 'restore') {
        terminalWindowRef.current?.restore()
      } else if (item.action === 'toggle-fullscreen') {
        terminalWindowRef.current?.toggleFullscreen()
      }
      closeTopMenu()
    },
    [closeTopMenu],
  )

  useEffect(() => {
    const updateTime = () => {
      const formatter = new Intl.DateTimeFormat(undefined, {
        hour: '2-digit',
        minute: '2-digit',
      })
      setCurrentTime(formatter.format(new Date()))
    }

    updateTime()
    const clockId = window.setInterval(updateTime, 1000)
    return () => {
      window.clearInterval(clockId)
    }
  }, [])

  useEffect(() => {
    const handleInteraction = (event: MouseEvent) => {
      const target = event.target
      if (!topMenuRef.current || !(target instanceof Node)) return
      if (!topMenuRef.current.contains(target)) {
        closeTopMenu()
      }
    }

    const handleEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        closeTopMenu()
      }
    }

    document.addEventListener('mousedown', handleInteraction)
    document.addEventListener('keydown', handleEscape)

    return () => {
      document.removeEventListener('mousedown', handleInteraction)
      document.removeEventListener('keydown', handleEscape)
    }
  }, [closeTopMenu])

  return (
    <main className="relative min-h-[100svh] overflow-hidden bg-[radial-gradient(circle_at_18%_0%,rgba(122,162,247,0.24)_0%,rgba(26,27,38,0)_42%),radial-gradient(circle_at_84%_72%,rgba(187,154,247,0.18)_0%,rgba(26,27,38,0)_58%),radial-gradient(circle_at_45%_30%,rgba(125,207,255,0.12)_0%,rgba(26,27,38,0)_56%),linear-gradient(180deg,#2b2f46_0%,#23263a_54%,#1b2342_100%)]">
      <div className="relative flex min-h-[100svh] flex-col">
        <header className="font-inter sticky top-0 z-20 h-11 border-b border-zinc-700/35 bg-black/35 px-3 py-1.5 text-[15px] font-normal text-zinc-100/90 backdrop-blur">
          <div className="mx-auto flex h-full max-w-[1200px] items-center justify-between">
            <div className="flex items-center gap-3">
              <div ref={topMenuRef} className="flex items-center gap-3">
                {topMenus.map((menu) => {
                  const isMenuActive = activeMenu === menu.id
                  return (
                    <div key={menu.id} className="relative">
                      <button
                        type="button"
                        onClick={() => {
                          toggleTopMenuAtButton(menu.id)
                        }}
                        className={`relative z-30 rounded-full px-3 py-1.5 text-[15px] font-normal transition-colors ${
                          menu.id === 'terminal' ? 'font-bold' : ''
                        } ${isMenuActive ? 'bg-white/15 text-zinc-50' : 'opacity-80'} hover:bg-white/10 hover:text-zinc-50`}
                        onMouseEnter={() => {
                          openTopMenuAtButton(menu.id)
                        }}
                        aria-expanded={activeMenu === menu.id}
                        aria-haspopup="menu"
                      >
                        <span className="relative">{menu.label}</span>
                      </button>
                      <AnimatePresence>
                        {isMenuActive ? (
                          <motion.div
                            initial={{ opacity: 0, y: -4 }}
                            animate={{ opacity: 1, y: 0 }}
                            exit={{ opacity: 0, y: -4 }}
                            transition={{ duration: 0.13, ease: 'easeOut' }}
                            className="absolute top-full left-0 z-30 mt-0.5 w-52 rounded-lg border border-zinc-600/35 bg-zinc-900/85 p-1.5 shadow-[0_16px_42px_-20px_rgba(0,0,0,0.75)] backdrop-blur-md"
                          >
                            {(topMenus.find((menu) => menu.id === activeMenu)?.items ?? []).map((item) => (
                              <button
                                key={item.id}
                                type="button"
                                className="flex w-full rounded-md px-2.5 py-2 text-left text-[13px] text-zinc-100 hover:bg-white/10"
                                onClick={() => {
                                  runTopMenuAction(item)
                                }}
                              >
                                {item.label}
                              </button>
                            ))}
                          </motion.div>
                        ) : null}
                      </AnimatePresence>
                    </div>
                  )
                })}
              </div>
            </div>
            <div className="flex cursor-default select-none items-center gap-3 opacity-80">
              <Wifi className="h-5 w-5 shrink-0" aria-hidden="true" />
              <span className="cursor-default font-semibold">{currentTime}</span>
            </div>
          </div>
        </header>

        <div className="relative z-10 flex-1 px-4 pb-32 pt-8 sm:px-8">
          <div className="mx-auto grid h-full max-w-[1200px] grid-cols-2 gap-5 px-2 sm:grid-cols-3 md:grid-cols-4">
            {DESKTOP_ITEMS.map((item) => (
              <button
                key={item.id}
                type="button"
                className="flex w-full flex-col items-center justify-end gap-1 text-3xl text-zinc-100/90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sky-300/40"
                aria-label={item.label}
              >
                {item.emoji}
                <span className="text-[11px] leading-none">{item.label}</span>
              </button>
            ))}
          </div>

          <TerminalWindow
            ref={terminalWindowRef}
            menuBarButtonRef={menuBarButtonRef}
            onClosedStateChange={setIsTerminalClosed}
          />
        </div>

        <footer className="pointer-events-none absolute inset-x-0 bottom-0 z-20 flex justify-center px-3 pb-4">
          <Dock
            items={DOCK_ITEMS}
            menuBarButtonRef={menuBarButtonRef}
            onTerminalClick={handleDockClick}
            isTerminalClosed={isTerminalClosed}
          />
        </footer>
      </div>
    </main>
  )
}

type DockItem = {
  id: string
  label: string
  emoji?: string
  terminal: boolean
}

type DockIconTransform = {
  scale: number
  y: number
  x: number
}

const Dock = memo(function Dock({
  items,
  menuBarButtonRef,
  onTerminalClick,
  isTerminalClosed,
}: {
  items: readonly DockItem[]
  menuBarButtonRef: RefObject<HTMLButtonElement | null>
  onTerminalClick: () => void
  isTerminalClosed: boolean
}) {
  const dockRefs = useRef<Array<HTMLButtonElement | null>>([])
  const dockCentersRef = useRef<number[]>([])
  const hoverIntentRef = useRef<number | null>(null)
  const dockPointerXRef = useRef<number | null>(null)
  const dockPointerXSmoothedRef = useRef<number | null>(null)
  const dockPosControlsRef = useRef<Array<ReturnType<typeof useAnimationControls> | null>>([])
  const dockScaleControlsRef = useRef<Array<ReturnType<typeof useAnimationControls> | null>>([])
  const dockCurrentRef = useRef<DockIconTransform[]>([])
  const shouldAnimateRef = useRef(false)
  const [hoveredIndex, setHoveredIndex] = useState<number | null>(null)

  const measureDockCenters = useCallback(() => {
    dockCentersRef.current = dockRefs.current.map((node) => {
      if (!node) return 0
      const rect = node.getBoundingClientRect()
      return rect.left + rect.width / 2
    })
  }, [])

  useEffect(() => {
    measureDockCenters()
    const onResize = () => measureDockCenters()
    window.addEventListener('resize', onResize)
    return () => window.removeEventListener('resize', onResize)
  }, [measureDockCenters])

  const handleDockPointerMove = useCallback((event: ReactPointerEvent<HTMLElement>) => {
    dockPointerXRef.current = event.clientX
    shouldAnimateRef.current = true
  }, [])

  const handleDockPointerLeave = useCallback(() => {
    dockPointerXRef.current = null
    if (hoverIntentRef.current !== null) window.clearTimeout(hoverIntentRef.current)
    hoverIntentRef.current = null
    setHoveredIndex(null)
    shouldAnimateRef.current = true
  }, [])

  useAnimationFrame(() => {
    if (!shouldAnimateRef.current) return

    const pointerXTarget = dockPointerXRef.current
    if (pointerXTarget === null) {
      dockPointerXSmoothedRef.current = null
    } else {
      const current = dockPointerXSmoothedRef.current ?? pointerXTarget
      dockPointerXSmoothedRef.current = current + (pointerXTarget - current) * 0.28
    }

    const pointerX = dockPointerXSmoothedRef.current
    const centers = dockCentersRef.current
    const posControls = dockPosControlsRef.current
    const scaleControls = dockScaleControlsRef.current
    const dockRect = dockRefs.current[0]?.parentElement?.getBoundingClientRect() ?? null

    const baseSize = 48
    const baseGap = 8
    const maxScaleBoost = 0.72
    const maxLift = 18
    const sigma = 70
    const settleEpsilonScale = 0.0025
    const settleEpsilonY = 0.14
    const settleEpsilonX = 0.35

    if (!dockCurrentRef.current.length) {
      dockCurrentRef.current = Array.from({ length: items.length }, () => ({ scale: 1, y: 0, x: 0 }))
    }

    const targetScales: number[] = Array.from({ length: items.length }, () => 1)
    const targetLift: number[] = Array.from({ length: items.length }, () => 0)

    if (pointerX !== null) {
      for (let i = 0; i < items.length; i += 1) {
        const center = centers[i] ?? 0
        const distance = Math.abs(pointerX - center)
        const influence = Math.exp(-(distance * distance) / (2 * sigma * sigma))
        targetScales[i] = 1 + influence * maxScaleBoost
        targetLift[i] = -influence * maxLift
      }
    }

    // Variable-width reflow model: compute desired icon centers using scaled widths, then translate
    // icons so they "make space" like the macOS dock (prevents overlap/clutter).
    const baseCentersLocal =
      dockRect && centers.length === items.length ? centers.map((c) => c - dockRect.left) : centers.map((c) => c)
    const widths = targetScales.map((s) => baseSize * s)
    const desiredCentersLocal: number[] = []
    let cursor = 0
    for (let i = 0; i < widths.length; i += 1) {
      const w = widths[i] ?? baseSize
      cursor += w / 2
      desiredCentersLocal[i] = cursor
      cursor += w / 2 + baseGap
    }

    let anchorIndex = 0
    if (pointerX !== null) {
      let best = Number.POSITIVE_INFINITY
      for (let i = 0; i < baseCentersLocal.length; i += 1) {
        const d = Math.abs((centers[i] ?? 0) - pointerX)
        if (d < best) {
          best = d
          anchorIndex = i
        }
      }
    }

    const anchorDelta = (baseCentersLocal[anchorIndex] ?? 0) - (desiredCentersLocal[anchorIndex] ?? 0)
    const targetX = desiredCentersLocal.map((c, i) => c + anchorDelta - (baseCentersLocal[i] ?? 0))

    let stillAnimating = false
    for (let i = 0; i < items.length; i += 1) {
      const posControl = posControls[i]
      const scaleControl = scaleControls[i]
      if (!posControl || !scaleControl) continue

      const targetScale = targetScales[i] ?? 1
      const targetY = targetLift[i] ?? 0
      const targetTranslateX = pointerX === null ? 0 : (targetX[i] ?? 0)

      const cur = dockCurrentRef.current[i] ?? { scale: 1, y: 0, x: 0 }
      const scale = cur.scale + (targetScale - cur.scale) * 0.2
      const y = cur.y + (targetY - cur.y) * 0.26
      const x = cur.x + (targetTranslateX - cur.x) * 0.22
      dockCurrentRef.current[i] = { scale, y, x }

      // Keep tooltip unaffected by magnification: translate the button, scale only the icon.
      posControl.set({ x, y })
      scaleControl.set({ scale })

      if (
        Math.abs(targetScale - scale) > settleEpsilonScale ||
        Math.abs(targetY - y) > settleEpsilonY ||
        Math.abs(targetTranslateX - x) > settleEpsilonX
      ) {
        stillAnimating = true
      }
    }

    if (pointerXTarget === null && !stillAnimating) {
      shouldAnimateRef.current = false
    }
  })

  return (
    <motion.nav
      className="pointer-events-auto relative flex items-end gap-2 rounded-[1.3rem] bg-zinc-950/18 px-3 py-2 shadow-[0_26px_70px_-38px_rgba(0,0,0,0.9)] backdrop-blur-2xl backdrop-saturate-150"
      onPointerEnter={() => {
        measureDockCenters()
        shouldAnimateRef.current = true
      }}
      onPointerMove={handleDockPointerMove}
      onPointerLeave={handleDockPointerLeave}
    >
      {items.map((dockItem, index) => {
        return (
          <DockButton
            key={dockItem.id}
            dockItem={dockItem}
            index={index}
            menuBarButtonRef={menuBarButtonRef}
            onTerminalClick={onTerminalClick}
            dockRefs={dockRefs}
            dockPosControlsRef={dockPosControlsRef}
            dockScaleControlsRef={dockScaleControlsRef}
            showTooltip={hoveredIndex === index}
            showRunningDot={dockItem.terminal && isTerminalClosed}
            onHoverStart={() => {
              if (hoverIntentRef.current !== null) window.clearTimeout(hoverIntentRef.current)
              hoverIntentRef.current = window.setTimeout(() => setHoveredIndex(index), 180)
            }}
            onHoverEnd={() => {
              if (hoverIntentRef.current !== null) window.clearTimeout(hoverIntentRef.current)
              hoverIntentRef.current = null
              setHoveredIndex((prev) => (prev === index ? null : prev))
            }}
          />
        )
      })}
    </motion.nav>
  )
})

function DockTooltip({ label }: { label: string }) {
  return (
    <motion.div
      initial={{ opacity: 0, y: 10, scale: 0.98 }}
      animate={{ opacity: 1, y: 0, scale: 1 }}
      exit={{ opacity: 0, y: 10, scale: 0.98 }}
      transition={{ duration: 0.14, ease: 'easeOut' }}
      className={[
        'pointer-events-none absolute left-1/2 bottom-full z-50 -translate-x-1/2',
        'mb-2.5 whitespace-nowrap rounded-[18px]',
        // macOS-style: slightly translucent, blurred, subtle border, tight padding.
        'bg-[rgba(14,16,24,0.58)] px-5 py-1.5 text-[15px] font-medium leading-none text-white/90',
        'shadow-[0_18px_44px_-28px_rgba(0,0,0,0.85)] backdrop-blur-xl ring-1 ring-white/14',
        // Tail: render a small triangle (not a rotated square) with a subtle border behind it.
        'before:absolute before:left-1/2 before:top-full before:-translate-x-1/2 before:-translate-y-[1px]',
        "before:h-3 before:w-4 before:bg-white/14 before:[clip-path:polygon(50%_100%,0_0,100%_0)] before:content-['']",
        'after:absolute after:left-1/2 after:top-full after:-translate-x-1/2 after:-translate-y-[2px]',
        "after:h-3 after:w-4 after:bg-[rgba(14,16,24,0.58)] after:[clip-path:polygon(50%_100%,0_0,100%_0)] after:content-['']",
      ].join(' ')}
      aria-hidden="true"
    >
      {label}
    </motion.div>
  )
}

function DockButton({
  dockItem,
  index,
  menuBarButtonRef,
  onTerminalClick,
  dockRefs,
  dockPosControlsRef,
  dockScaleControlsRef,
  showTooltip,
  showRunningDot,
  onHoverStart,
  onHoverEnd,
}: {
  dockItem: DockItem
  index: number
  menuBarButtonRef: RefObject<HTMLButtonElement | null>
  onTerminalClick: () => void
  dockRefs: MutableRefObject<Array<HTMLButtonElement | null>>
  dockPosControlsRef: MutableRefObject<Array<ReturnType<typeof useAnimationControls> | null>>
  dockScaleControlsRef: MutableRefObject<Array<ReturnType<typeof useAnimationControls> | null>>
  showTooltip: boolean
  showRunningDot: boolean
  onHoverStart: () => void
  onHoverEnd: () => void
}) {
  const posControls = useAnimationControls()
  const scaleControls = useAnimationControls()

  useEffect(() => {
    dockPosControlsRef.current[index] = posControls
    dockScaleControlsRef.current[index] = scaleControls
    return () => {
      if (dockPosControlsRef.current[index] === posControls) dockPosControlsRef.current[index] = null
      if (dockScaleControlsRef.current[index] === scaleControls) dockScaleControlsRef.current[index] = null
    }
  }, [dockPosControlsRef, dockScaleControlsRef, index, posControls, scaleControls])

  if (dockItem.terminal) {
    return (
      <motion.button
        type="button"
        ref={(node) => {
          dockRefs.current[index] = node
          menuBarButtonRef.current = node
        }}
        onClick={onTerminalClick}
        onKeyDown={(event) => {
          if (event.key !== ' ' && event.key !== 'Enter') return
          event.preventDefault()
          onTerminalClick()
        }}
        onPointerEnter={onHoverStart}
        onPointerLeave={onHoverEnd}
        animate={posControls}
        className={cn(
          'relative isolate inline-flex h-12 w-12 items-center justify-center overflow-visible p-0 leading-none text-zinc-100',
          'transform-gpu will-change-transform',
          showTooltip ? 'z-40' : 'z-10',
        )}
        aria-label={dockItem.label}
      >
        <motion.div animate={scaleControls} className="relative z-10 transform-gpu will-change-transform">
          <Image
            src="/macos-terminal-icon.png"
            alt="proompteng"
            width={48}
            height={48}
            className="size-12 object-contain"
            priority
          />
        </motion.div>
        {showRunningDot ? (
          <span
            aria-hidden="true"
            className="absolute left-1/2 top-full mt-1 size-[6px] -translate-x-1/2 rounded-full bg-white/85 shadow-[0_0_0_1px_rgba(0,0,0,0.35)]"
          />
        ) : null}
        <AnimatePresence>{showTooltip ? <DockTooltip label={dockItem.label} /> : null}</AnimatePresence>
      </motion.button>
    )
  }

  return (
    <motion.button
      type="button"
      ref={(node) => {
        dockRefs.current[index] = node
      }}
      onPointerEnter={onHoverStart}
      onPointerLeave={onHoverEnd}
      animate={posControls}
      className={cn(
        'relative isolate inline-flex h-12 w-12 items-center justify-center overflow-visible p-0 leading-none text-zinc-100',
        'transform-gpu will-change-transform',
        showTooltip ? 'z-40' : 'z-10',
      )}
      aria-label={dockItem.label}
    >
      <motion.span
        animate={scaleControls}
        className="relative z-10 transform-gpu will-change-transform text-[34px] leading-none"
      >
        {dockItem.emoji}
      </motion.span>
      <AnimatePresence>{showTooltip ? <DockTooltip label={dockItem.label} /> : null}</AnimatePresence>
    </motion.button>
  )
}
