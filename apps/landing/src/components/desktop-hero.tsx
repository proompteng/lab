'use client'

import { ArrowUpRight, Wifi } from 'lucide-react'
import { AnimatePresence, motion } from 'motion/react'
import { useCallback, useEffect, useRef, useState } from 'react'

type TopMenuItem = {
  id: string
  label: string
  href?: string
  action?: 'show-about'
}

type TopMenuSection = {
  id: string
  label: string
  items: TopMenuItem[]
}

const topMenus: TopMenuSection[] = [
  {
    id: 'proompteng',
    label: 'proompteng',
    items: [
      { id: 'about', label: 'About proompteng', action: 'show-about' },
      { id: 'docs', label: 'Documentation', href: 'https://docs.proompteng.ai' },
    ],
  },
  {
    id: 'help',
    label: 'Help',
    items: [
      { id: 'docs', label: 'Docs', href: 'https://docs.proompteng.ai' },
      { id: 'release-notes', label: 'Release Notes', href: 'https://github.com/proompteng/lab/releases' },
      { id: 'report', label: 'Report Issue…', href: 'https://github.com/proompteng/lab/issues' },
    ],
  },
]

export default function DesktopHero() {
  const topMenuRef = useRef<HTMLDivElement>(null)
  const [currentTime, setCurrentTime] = useState('--:--')
  const [activeMenu, setActiveMenu] = useState<string | null>(null)
  const [isAboutDialogOpen, setIsAboutDialogOpen] = useState(false)

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
      if (item.href) {
        window.open(item.href, '_blank', 'noopener,noreferrer')
        closeTopMenu()
        return
      }
      if (item.action === 'show-about') {
        setIsAboutDialogOpen(true)
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
        setIsAboutDialogOpen(false)
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
                          menu.id === 'proompteng' ? 'font-bold' : ''
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
                            {(topMenus.find((menu) => menu.id === activeMenu)?.items ?? []).map((item) => (
                              <button
                                key={item.id}
                                type="button"
                                className="flex w-full items-center rounded-md px-2.5 py-2 text-left text-[13px] text-[rgb(192_202_245)] hover:bg-[rgb(61_89_161/0.52)]"
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
            <div className="flex cursor-default select-none items-center gap-2 text-[12px] text-[rgb(169_177_214/0.95)]">
              <Wifi className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
              <span className="cursor-default font-medium tracking-[0.01em]">{currentTime}</span>
            </div>
          </div>
        </header>

        <div className="relative z-10 flex min-h-0 flex-1 overflow-y-auto p-4 sm:p-6">
          <PublicWelcomeWindow />

          {isAboutDialogOpen ? (
            <div
              className="fixed inset-0 z-[120] flex items-center justify-center bg-[rgba(9,11,20,0.72)] px-4"
              onMouseDown={() => {
                setIsAboutDialogOpen(false)
              }}
            >
              <div
                role="dialog"
                aria-modal="true"
                aria-labelledby="about-proompteng-title"
                className="w-full max-w-md rounded-2xl border border-[rgb(84_92_126/0.5)] bg-[rgba(31,35,53,0.97)] p-5 shadow-[0_24px_55px_rgba(0,0,0,0.45)] backdrop-blur"
                onMouseDown={(event) => {
                  event.stopPropagation()
                }}
              >
                <h2 id="about-proompteng-title" className="text-lg font-semibold text-[rgb(192_202_245)]">
                  About proompteng
                </h2>
                <p className="mt-3 text-sm leading-relaxed text-[rgb(182_190_227)]">
                  proompteng helps teams ship reliable AI agents faster with guardrails, observability, and model
                  routing in one platform.
                </p>
                <div className="mt-5 flex justify-end">
                  <button
                    type="button"
                    onClick={() => {
                      setIsAboutDialogOpen(false)
                    }}
                    className="rounded-md bg-[rgb(66_77_125/0.9)] px-3 py-2 text-sm text-[rgb(230_235_255)] transition hover:bg-[rgb(82_97_164/0.96)]"
                  >
                    Close
                  </button>
                </div>
              </div>
            </div>
          ) : null}
        </div>
      </div>
    </main>
  )
}

function PublicWelcomeWindow() {
  return (
    <section
      aria-labelledby="public-welcome-title"
      className="m-auto w-[min(92vw,36rem)] shrink-0 overflow-hidden rounded-[22px] border border-[rgb(84_92_126/0.5)] bg-[rgba(31,35,53,0.76)] shadow-[0_32px_90px_-38px_rgba(0,0,0,0.92)] backdrop-blur-2xl"
    >
      <div className="flex h-10 items-center gap-2 border-b border-[rgb(84_92_126/0.36)] bg-[rgba(41,46,66,0.72)] px-3">
        <span aria-hidden="true" className="size-3 rounded-full bg-[#ed6a5f]" />
        <span aria-hidden="true" className="size-3 rounded-full bg-[#f6be50]" />
        <span aria-hidden="true" className="size-3 rounded-full bg-[#61c555]" />
        <span className="absolute left-1/2 -translate-x-1/2 text-xs font-medium text-[rgb(192_202_245/0.78)]">
          proompteng
        </span>
      </div>
      <div className="px-7 py-8 sm:px-9 sm:py-10">
        <p className="text-xs font-semibold tracking-[0.18em] text-[rgb(125_207_255/0.82)] uppercase">
          Private agent workspaces
        </p>
        <h1 id="public-welcome-title" className="mt-3 text-3xl font-semibold tracking-[-0.03em] text-white sm:text-4xl">
          Tengri runs every agent in its own microVM.
        </h1>
        <p className="mt-4 max-w-lg text-sm leading-6 text-[rgb(192_202_245/0.72)] sm:text-[15px]">
          This deployment has not enabled the authenticated workspace yet. There is no simulated agent activity on this
          screen.
        </p>
        <a
          href="https://docs.proompteng.ai"
          target="_blank"
          rel="noreferrer"
          className="mt-7 inline-flex items-center gap-2 rounded-xl border border-[rgb(122_162_247/0.38)] bg-[rgb(61_89_161/0.44)] px-4 py-2.5 text-sm font-semibold text-white outline-none transition hover:bg-[rgb(61_89_161/0.62)] focus-visible:ring-2 focus-visible:ring-[rgb(125_207_255/0.85)]"
        >
          Read the documentation
          <ArrowUpRight aria-hidden="true" className="size-4" />
        </a>
      </div>
    </section>
  )
}
