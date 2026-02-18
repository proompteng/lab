'use client'

import { Wifi } from 'lucide-react'
import { AnimatePresence, motion, useMotionValue, useReducedMotion, useSpring, useTransform } from 'motion/react'
import Image from 'next/image'
import {
  memo,
  type PointerEvent as ReactPointerEvent,
  type RefObject,
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from 'react'

import TerminalWindow, { type TerminalWindowHandle } from '@/components/terminal-window'
import { cn } from '@/lib/utils'

type TopMenuItem = {
  id: string
  label: string
  action?: 'minimize' | 'restore' | 'toggle-fullscreen'
  shortcut?: string
  separatorBefore?: boolean
  destructive?: boolean
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
      { id: 'sep-hide', label: '', separatorBefore: true },
      { id: 'hide', label: 'Hide proompteng' },
      { id: 'hide-others', label: 'Hide Others' },
      { id: 'show-all', label: 'Show All' },
      { id: 'sep-quit', label: '', separatorBefore: true },
      { id: 'quit', label: 'Quit proompteng', action: 'minimize', shortcut: '⌘Q', destructive: true },
    ],
  },
  {
    id: 'file',
    label: 'File',
    items: [
      { id: 'new', label: 'New Window' },
      { id: 'open', label: 'Open' },
      { id: 'close', label: 'Close Window', action: 'minimize', shortcut: '⌘W' },
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
      { id: 'as', label: 'Enter Full Screen', action: 'toggle-fullscreen', shortcut: '⌃⌘F' },
      { id: 'zoom-in', label: 'Zoom In' },
      { id: 'zoom-out', label: 'Zoom Out' },
      { id: 'toggle', label: 'Toggle Toolbar' },
    ],
  },
  {
    id: 'window',
    label: 'Window',
    items: [
      { id: 'minimize', label: 'Minimize', action: 'minimize', shortcut: '⌘M' },
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
  const desktopStageRef = useRef<HTMLDivElement>(null)
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
        weekday: 'short',
        month: 'short',
        day: 'numeric',
        hour: 'numeric',
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
    <main className="relative min-h-[100svh] overflow-hidden bg-[radial-gradient(circle_at_18%_0%,rgba(122,162,247,0.26)_0%,rgba(36,40,59,0)_42%),radial-gradient(circle_at_82%_74%,rgba(187,154,247,0.18)_0%,rgba(36,40,59,0)_58%),radial-gradient(circle_at_48%_34%,rgba(125,207,255,0.13)_0%,rgba(36,40,59,0)_56%),linear-gradient(180deg,#24283b_0%,#1f2335_56%,#1b1e2d_100%)]">
      <div className="relative flex min-h-[100svh] flex-col">
        <header className="font-inter sticky top-0 z-20 h-11 border-b border-[rgb(84_92_126/0.45)] bg-[linear-gradient(180deg,rgba(61,89,161,0.64)_0%,rgba(41,46,66,0.86)_100%)] px-3 py-1 text-[13px] font-medium text-[rgb(192_202_245/0.95)] backdrop-blur-xl">
          <div className="mx-auto flex h-full max-w-[1200px] items-center justify-between">
            <div className="flex items-center gap-2">
              <button
                type="button"
                className="rounded-full px-2 py-1 text-[13px] leading-none text-[rgb(192_202_245/0.95)] transition-colors hover:bg-[rgb(122_162_247/0.24)]"
                aria-label="Apple menu"
              >
                
              </button>
              <div ref={topMenuRef} className="flex items-center gap-1">
                {topMenus.map((menu) => {
                  const isMenuActive = activeMenu === menu.id
                  return (
                    <div key={menu.id} className="relative">
                      <button
                        type="button"
                        onClick={() => {
                          toggleTopMenuAtButton(menu.id)
                        }}
                        className={`relative z-30 rounded-full px-2.5 py-1.5 text-[13px] leading-none font-medium transition-colors ${
                          menu.id === 'terminal' ? 'font-bold' : ''
                        } ${
                          isMenuActive
                            ? 'bg-[linear-gradient(180deg,rgba(122,162,247,0.52)_0%,rgba(61,89,161,0.66)_100%)] text-[rgb(192_202_245)] shadow-[inset_0_1px_0_rgba(192,202,245,0.24)]'
                            : 'text-[rgb(192_202_245/0.92)]'
                        } hover:bg-[linear-gradient(180deg,rgba(122,162,247,0.36)_0%,rgba(61,89,161,0.44)_100%)] hover:text-[rgb(192_202_245)]`}
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
                            className="absolute top-full left-0 z-30 mt-1.5 w-60 rounded-xl border border-[rgb(84_92_126/0.45)] bg-[rgba(31,35,53,0.9)] p-1.5 shadow-[0_22px_44px_-20px_rgba(0,0,0,0.9)] backdrop-blur-xl"
                          >
                            {(topMenus.find((menu) => menu.id === activeMenu)?.items ?? []).map((item) => {
                              if (item.separatorBefore) {
                                return (
                                  <div key={item.id} className="my-1 h-px bg-[rgb(84_92_126/0.38)]" role="separator" />
                                )
                              }

                              return (
                                <button
                                  key={item.id}
                                  type="button"
                                  className={cn(
                                    'flex w-full items-center justify-between rounded-md px-2.5 py-2 text-left text-[13px] text-[rgb(192_202_245)]',
                                    'hover:bg-[rgb(61_89_161/0.52)]',
                                    item.destructive ? 'text-red-200' : '',
                                  )}
                                  onClick={() => {
                                    runTopMenuAction(item)
                                  }}
                                >
                                  <span>{item.label}</span>
                                  <span className="font-medium text-[11px] tracking-wide text-[rgb(115_122_162/0.9)]">
                                    {item.shortcut ?? ''}
                                  </span>
                                </button>
                              )
                            })}
                          </motion.div>
                        ) : null}
                      </AnimatePresence>
                    </div>
                  )
                })}
              </div>
            </div>
            <div className="flex cursor-default select-none items-center gap-2 text-[12px] text-[rgb(169_177_214/0.95)]">
              <Wifi className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
              <span className="cursor-default font-medium tracking-[0.01em]">{currentTime}</span>
            </div>
          </div>
        </header>

        <div ref={desktopStageRef} className="relative z-10 flex-1 overflow-hidden">
          <TerminalWindow
            ref={terminalWindowRef}
            desktopBoundsRef={desktopStageRef}
            menuBarButtonRef={menuBarButtonRef}
            onClosedStateChange={setIsTerminalClosed}
          />

          <footer className="pointer-events-none absolute inset-x-0 bottom-0 z-[90] flex justify-center px-3 pb-4">
            <Dock
              items={DOCK_ITEMS}
              menuBarButtonRef={menuBarButtonRef}
              onTerminalClick={handleDockClick}
              isTerminalClosed={isTerminalClosed}
            />
          </footer>
        </div>
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

const DOCK_BASE_SIZE_PX = 48
const DOCK_MAX_SCALE = 1.82
const DOCK_EFFECT_RADIUS_PX = 152
const DOCK_HOVER_DELAY_MS = 140
const DOCK_TOOLTIP_TEXT_SIZE_PX = 13
const DOCK_TOOLTIP_LINE_HEIGHT_PX = 18
const DOCK_TOOLTIP_PADDING_X_PX = 16
const DOCK_TOOLTIP_PADDING_Y_PX = 6
const DOCK_TOOLTIP_MIN_WIDTH_PX = 88
const DOCK_TOOLTIP_MIN_BODY_HEIGHT_PX = 30
const DOCK_TOOLTIP_TAIL_HEIGHT_PX = 8
const DOCK_TOOLTIP_RADIUS_PX = 15

function clampValue(value: number, min: number, max: number) {
  return Math.min(Math.max(value, min), max)
}

function createDockTooltipPath(
  width: number,
  bodyHeight: number,
  radius: number,
  tailWidth: number,
  tailHeight: number,
) {
  const safeRadius = clampValue(radius, 4, Math.min(width / 2 - 1, bodyHeight / 2 - 1))
  const centerX = width / 2
  const halfTail = tailWidth / 2
  const tailLeft = clampValue(centerX - halfTail, safeRadius + 6, width - safeRadius - 6)
  const tailRight = clampValue(centerX + halfTail, safeRadius + 6, width - safeRadius - 6)
  const tailCurvePull = Math.max(3, halfTail * 0.72)
  const tipY = bodyHeight + tailHeight

  return [
    `M ${safeRadius} 0`,
    `H ${width - safeRadius}`,
    `Q ${width} 0 ${width} ${safeRadius}`,
    `V ${bodyHeight - safeRadius}`,
    `Q ${width} ${bodyHeight} ${width - safeRadius} ${bodyHeight}`,
    `H ${tailRight}`,
    `Q ${centerX + tailCurvePull} ${bodyHeight} ${centerX} ${tipY}`,
    `Q ${centerX - tailCurvePull} ${bodyHeight} ${tailLeft} ${bodyHeight}`,
    `H ${safeRadius}`,
    `Q 0 ${bodyHeight} 0 ${bodyHeight - safeRadius}`,
    `V ${safeRadius}`,
    `Q 0 0 ${safeRadius} 0`,
    'Z',
  ].join(' ')
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
  const hoverIntentRef = useRef<number | null>(null)
  const [hoveredIndex, setHoveredIndex] = useState<number | null>(null)
  const pointerX = useMotionValue(Number.POSITIVE_INFINITY)

  const clearHoverIntent = useCallback(() => {
    if (hoverIntentRef.current !== null) {
      window.clearTimeout(hoverIntentRef.current)
      hoverIntentRef.current = null
    }
  }, [])

  useEffect(
    () => () => {
      clearHoverIntent()
    },
    [clearHoverIntent],
  )

  return (
    <motion.nav
      className={cn(
        'pointer-events-auto relative z-[95] flex items-end gap-[18px] overflow-visible rounded-[22px] px-6 py-3',
        'bg-[rgba(31,35,53,0.56)] shadow-[0_26px_70px_-44px_rgba(0,0,0,0.95)] backdrop-blur-2xl backdrop-saturate-150',
        'ring-1 ring-[rgb(84_92_126/0.5)]',
      )}
      onPointerMove={(event: ReactPointerEvent<HTMLElement>) => {
        pointerX.set(event.clientX)
      }}
      onPointerLeave={() => {
        pointerX.set(Number.POSITIVE_INFINITY)
        clearHoverIntent()
        setHoveredIndex(null)
      }}
    >
      {items.map((dockItem, index) => {
        return (
          <DockButton
            key={dockItem.id}
            dockItem={dockItem}
            menuBarButtonRef={menuBarButtonRef}
            pointerX={pointerX}
            onTerminalClick={onTerminalClick}
            showTooltip={hoveredIndex === index}
            showRunningDot={dockItem.terminal && isTerminalClosed}
            onHoverStart={() => {
              clearHoverIntent()
              hoverIntentRef.current = window.setTimeout(() => setHoveredIndex(index), DOCK_HOVER_DELAY_MS)
            }}
            onHoverEnd={() => {
              clearHoverIntent()
              setHoveredIndex((prev) => (prev === index ? null : prev))
            }}
          />
        )
      })}
    </motion.nav>
  )
})

function DockTooltip({ label }: { label: string }) {
  const labelRef = useRef<HTMLSpanElement | null>(null)
  const [labelWidth, setLabelWidth] = useState(0)

  useLayoutEffect(() => {
    const node = labelRef.current
    if (!node) return

    const measure = () => {
      const nextWidth = Math.ceil(node.getBoundingClientRect().width)
      setLabelWidth((prev) => (prev === nextWidth ? prev : nextWidth))
    }

    measure()

    const resizeObserver = new ResizeObserver(() => {
      measure()
    })
    resizeObserver.observe(node)
    return () => {
      resizeObserver.disconnect()
    }
  }, [label])

  const bodyWidth = Math.max(DOCK_TOOLTIP_MIN_WIDTH_PX, labelWidth + DOCK_TOOLTIP_PADDING_X_PX * 2)
  const bodyHeight = Math.max(
    DOCK_TOOLTIP_MIN_BODY_HEIGHT_PX,
    DOCK_TOOLTIP_LINE_HEIGHT_PX + DOCK_TOOLTIP_PADDING_Y_PX * 2,
  )
  const totalHeight = bodyHeight + DOCK_TOOLTIP_TAIL_HEIGHT_PX
  const tailWidth = clampValue(bodyWidth * 0.22, 12, 24)
  const tooltipPath = createDockTooltipPath(
    bodyWidth,
    bodyHeight,
    DOCK_TOOLTIP_RADIUS_PX,
    tailWidth,
    DOCK_TOOLTIP_TAIL_HEIGHT_PX,
  )

  return (
    <motion.div
      initial={{ opacity: 0, y: 10, scale: 0.98 }}
      animate={{ opacity: 1, y: 0, scale: 1 }}
      exit={{ opacity: 0, y: 10, scale: 0.98 }}
      transition={{ duration: 0.14, ease: 'easeOut' }}
      className={cn(
        'pointer-events-none absolute left-1/2 bottom-full z-[120] -translate-x-1/2',
        'mb-3 whitespace-nowrap',
        'text-[13px] font-medium leading-none text-[rgb(192_202_245/0.96)]',
      )}
      style={{ width: bodyWidth, height: totalHeight }}
      aria-hidden="true"
    >
      <svg
        className="absolute inset-0"
        width={bodyWidth}
        height={totalHeight}
        viewBox={`0 0 ${bodyWidth} ${totalHeight}`}
        preserveAspectRatio="none"
        aria-hidden="true"
      >
        <path
          d={tooltipPath}
          fill="rgb(31 35 53 / 0.88)"
          stroke="rgb(84 92 126 / 0.62)"
          strokeWidth="1"
          vectorEffect="non-scaling-stroke"
          style={{
            filter: 'drop-shadow(0 12px 20px rgba(0,0,0,0.42))',
          }}
        />
      </svg>
      <span
        className="absolute inset-x-0 top-0 flex items-center justify-center font-semibold tracking-[0.01em]"
        style={{
          height: bodyHeight,
          fontSize: DOCK_TOOLTIP_TEXT_SIZE_PX,
          lineHeight: `${DOCK_TOOLTIP_LINE_HEIGHT_PX}px`,
          paddingLeft: DOCK_TOOLTIP_PADDING_X_PX,
          paddingRight: DOCK_TOOLTIP_PADDING_X_PX,
          paddingTop: DOCK_TOOLTIP_PADDING_Y_PX,
          paddingBottom: DOCK_TOOLTIP_PADDING_Y_PX,
        }}
      >
        <span ref={labelRef} className="inline-block">
          {label}
        </span>
      </span>
    </motion.div>
  )
}

function DockButton({
  dockItem,
  menuBarButtonRef,
  pointerX,
  onTerminalClick,
  showTooltip,
  showRunningDot,
  onHoverStart,
  onHoverEnd,
}: {
  dockItem: DockItem
  menuBarButtonRef: RefObject<HTMLButtonElement | null>
  pointerX: ReturnType<typeof useMotionValue<number>>
  onTerminalClick: () => void
  showTooltip: boolean
  showRunningDot: boolean
  onHoverStart: () => void
  onHoverEnd: () => void
}) {
  const buttonRef = useRef<HTMLButtonElement | null>(null)
  const reducedMotion = useReducedMotion()

  const scaleTarget = useTransform(() => {
    if (reducedMotion) return 1
    const pointer = pointerX.get()
    if (!Number.isFinite(pointer)) return 1
    const rect = buttonRef.current?.getBoundingClientRect()
    if (!rect) return 1

    const center = rect.left + rect.width / 2
    const distance = Math.abs(pointer - center)
    if (distance >= DOCK_EFFECT_RADIUS_PX) return 1

    const t = distance / DOCK_EFFECT_RADIUS_PX
    const influence = Math.cos((t * Math.PI) / 2)
    return 1 + influence * influence * (DOCK_MAX_SCALE - 1)
  })

  const scale = useSpring(scaleTarget, {
    stiffness: 430,
    damping: 34,
    mass: 0.24,
  })
  const iconSize = useTransform(scale, (value) => value * DOCK_BASE_SIZE_PX)
  const lift = useTransform(scale, (value) => -(value - 1) * 18)
  const emojiFontSize = useTransform(iconSize, (value) => Math.max(30, value * 0.66))

  const assignButtonRef = useCallback(
    (node: HTMLButtonElement | null) => {
      buttonRef.current = node
      if (dockItem.terminal) menuBarButtonRef.current = node
    },
    [dockItem.terminal, menuBarButtonRef],
  )

  if (dockItem.terminal) {
    return (
      <motion.button
        type="button"
        ref={assignButtonRef}
        onClick={onTerminalClick}
        onKeyDown={(event) => {
          if (event.key !== ' ' && event.key !== 'Enter') return
          event.preventDefault()
          onTerminalClick()
        }}
        onPointerEnter={onHoverStart}
        onPointerLeave={onHoverEnd}
        className={cn(
          'relative isolate inline-flex shrink-0 items-center justify-center overflow-visible p-0 leading-none text-zinc-100',
          'transform-gpu will-change-transform',
          showTooltip ? 'z-50' : 'z-10',
        )}
        style={{ width: iconSize, height: iconSize, y: lift }}
        aria-label={dockItem.label}
      >
        <motion.span
          className="relative z-10 block shrink-0 transform-gpu will-change-transform"
          style={{ width: iconSize, height: iconSize }}
        >
          <Image
            src="/macos-terminal-icon.png"
            alt="proompteng"
            width={48}
            height={48}
            className="block h-full w-full object-contain"
            draggable={false}
            priority
          />
        </motion.span>
        {showRunningDot ? (
          <span
            aria-hidden="true"
            className="absolute left-1/2 top-full mt-1 size-[6px] -translate-x-1/2 rounded-full bg-[rgb(192_202_245/0.9)] shadow-[0_0_0_1px_rgba(31,35,53,0.85)]"
          />
        ) : null}
        <AnimatePresence>{showTooltip ? <DockTooltip label={dockItem.label} /> : null}</AnimatePresence>
      </motion.button>
    )
  }

  return (
    <motion.button
      type="button"
      ref={assignButtonRef}
      onPointerEnter={onHoverStart}
      onPointerLeave={onHoverEnd}
      className={cn(
        'relative isolate inline-flex shrink-0 items-center justify-center overflow-visible p-0 leading-none text-zinc-100',
        'transform-gpu will-change-transform',
        showTooltip ? 'z-50' : 'z-10',
      )}
      style={{ width: iconSize, height: iconSize, y: lift }}
      aria-label={dockItem.label}
    >
      <motion.span
        className="relative z-10 transform-gpu leading-none will-change-transform"
        style={{ fontSize: emojiFontSize }}
      >
        {dockItem.emoji}
      </motion.span>
      <AnimatePresence>{showTooltip ? <DockTooltip label={dockItem.label} /> : null}</AnimatePresence>
    </motion.button>
  )
}
