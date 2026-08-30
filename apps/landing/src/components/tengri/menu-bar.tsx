'use client'

import { Wifi } from 'lucide-react'
import { useEffect, useRef } from 'react'

import type { TengriAgent } from '@/lib/tengri/types'
import { APP_TITLES, type TengriApp } from '@/lib/tengri/window-manager'
import { DOCK_APPS } from './desktop-apps'

type MenuEntry = {
  label: string
  shortcut?: string
  run: () => void | Promise<void>
  separator?: boolean
}

export function MenuBar({
  activeApp,
  agent,
  clock,
  connectionWarning,
  menuOpen,
  onCloseActive,
  onMenuChange,
  onMinimizeActive,
  onNewWindow,
  onOpenApp,
  onOpenSpotlight,
  onSignOut,
  onToggleMaximize,
  userName,
}: {
  activeApp: TengriApp
  agent: TengriAgent
  clock: Date | null
  connectionWarning: string
  menuOpen: string | null
  onCloseActive: () => void
  onMenuChange: (menu: string | null) => void
  onMinimizeActive: () => void
  onNewWindow: () => void
  onOpenApp: (app: TengriApp) => void
  onOpenSpotlight: () => void
  onSignOut: () => void
  onToggleMaximize: () => void
  userName: string
}) {
  const triggerRefs = useRef(new Map<string, HTMLButtonElement>())
  const editTargetRef = useRef<HTMLElement | null>(null)

  const rememberEditTarget = (target: EventTarget | null) => {
    if (target instanceof HTMLElement && !target.closest('[role="menubar"]')) editTargetRef.current = target
  }

  const runEditCommand = (command: 'copy' | 'paste' | 'redo' | 'undo') => {
    const target = editTargetRef.current
    target?.focus({ preventScroll: true })
    if (command !== 'paste') {
      document.execCommand(command)
      return
    }
    if (!navigator.clipboard?.readText) {
      document.execCommand('paste')
      return
    }
    void navigator.clipboard
      .readText()
      .then((text) => {
        target?.focus({ preventScroll: true })
        document.execCommand('insertText', false, text)
      })
      .catch(() => {
        target?.focus({ preventScroll: true })
        document.execCommand('paste')
      })
  }

  const menus: Record<string, MenuEntry[]> = {
    tengri: [
      { label: 'About Tengri', run: () => onOpenApp('settings') },
      { label: 'System Settings…', run: () => onOpenApp('settings') },
      { label: 'Sign Out', run: onSignOut, separator: true },
    ],
    [APP_TITLES[activeApp]]: [
      { label: `About ${APP_TITLES[activeApp]}`, run: () => onOpenApp('settings') },
      { label: `Close ${APP_TITLES[activeApp]} Window`, shortcut: '⌘W', run: onCloseActive, separator: true },
    ],
    File: [
      { label: `New ${APP_TITLES[activeApp]} Window`, shortcut: '⌘N', run: onNewWindow },
      { label: 'Open…', shortcut: '⌘O', run: onOpenSpotlight },
      { label: 'Close Window', shortcut: '⌘W', run: onCloseActive },
    ],
    Edit: [
      { label: 'Undo', shortcut: '⌘Z', run: () => runEditCommand('undo') },
      { label: 'Redo', shortcut: '⇧⌘Z', run: () => runEditCommand('redo') },
      { label: 'Copy', shortcut: '⌘C', run: () => runEditCommand('copy'), separator: true },
      { label: 'Paste', shortcut: '⌘V', run: () => runEditCommand('paste') },
    ],
    View: [
      { label: 'Enter Full Screen', shortcut: '⌃⌘F', run: onToggleMaximize },
      { label: 'Open Spotlight', shortcut: '⌘Space', run: onOpenSpotlight },
    ],
    Window: [
      { label: 'Minimize', shortcut: '⌘M', run: onMinimizeActive },
      ...DOCK_APPS.map((app) => ({ label: APP_TITLES[app], run: () => onOpenApp(app) })),
    ],
    Help: [
      {
        label: 'Tengri Help',
        run: () => window.open('https://docs.proompteng.ai', '_blank', 'noopener,noreferrer'),
      },
    ],
  }
  const menuNames = ['tengri', APP_TITLES[activeApp], 'File', 'Edit', 'View', 'Window', 'Help']
  const visibleMenuNames = () =>
    menuNames.filter((menu) => (triggerRefs.current.get(menu)?.getClientRects().length ?? 0) > 0)
  const focusMenu = (menu: string) => window.requestAnimationFrame(() => triggerRefs.current.get(menu)?.focus())
  const moveMenu = (currentMenu: string, delta: -1 | 1) => {
    const availableMenus = visibleMenuNames()
    const current = availableMenus.indexOf(currentMenu)
    const next = availableMenus[(current + delta + availableMenus.length) % availableMenus.length]
    if (!next) return
    const isMenuOpen = menuOpen !== null
    onMenuChange(isMenuOpen ? next : null)
    if (!isMenuOpen) focusMenu(next)
  }

  return (
    <header className="absolute inset-x-0 top-0 z-[2000] flex h-[30px] items-center justify-between border-b border-white/10 bg-[rgba(16,20,31,0.5)] px-3 text-[12px] shadow-sm backdrop-blur-2xl">
      <nav aria-label="Application menu" className="flex h-full min-w-0 items-center gap-0.5" role="menubar">
        {menuNames.map((menu, index) => {
          const key = menu === APP_TITLES[activeApp] ? 'active' : menu
          const entries = menus[menu] ?? []
          const menuId = `tengri-menu-${key.toLowerCase().replaceAll(' ', '-')}`
          let visibility = ''
          if (key !== 'tengri' && key !== 'active') {
            visibility = menu === 'File' || menu === 'Edit' ? 'hidden sm:block' : 'hidden md:block'
          }
          return (
            <div className={`relative h-full ${visibility}`} key={key}>
              <button
                ref={(element) => {
                  if (element) triggerRefs.current.set(menu, element)
                  else triggerRefs.current.delete(menu)
                }}
                aria-controls={menuId}
                aria-expanded={menuOpen === menu}
                aria-haspopup="menu"
                aria-label={menu === 'tengri' ? 'Tengri menu' : undefined}
                className={`flex h-full items-center rounded px-2 text-white/82 outline-none hover:bg-white/10 focus-visible:ring-2 focus-visible:ring-white/50 ${key === 'active' ? 'font-semibold' : ''}`}
                id={`${menuId}-trigger`}
                onClick={(event) => {
                  event.stopPropagation()
                  onMenuChange(menuOpen === menu ? null : menu)
                }}
                onFocus={(event) => rememberEditTarget(event.relatedTarget)}
                onKeyDown={(event) => {
                  if (event.key === 'ArrowDown' || event.key === 'Enter' || event.key === ' ') {
                    event.preventDefault()
                    onMenuChange(menu)
                  } else if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
                    event.preventDefault()
                    moveMenu(menu, event.key === 'ArrowLeft' ? -1 : 1)
                  } else if (event.key === 'Home' || event.key === 'End') {
                    event.preventDefault()
                    const availableMenus = visibleMenuNames()
                    const target = event.key === 'Home' ? availableMenus[0] : availableMenus.at(-1)
                    if (target) focusMenu(target)
                  } else if (event.key === 'Escape') {
                    event.preventDefault()
                    onMenuChange(null)
                  }
                }}
                onPointerDown={() => rememberEditTarget(document.activeElement)}
                onPointerEnter={() => {
                  if (menuOpen && menuOpen !== menu) onMenuChange(menu)
                }}
                role="menuitem"
                tabIndex={index === 0 ? 0 : -1}
                type="button"
              >
                {menu === 'tengri' ? (
                  <TengriMark />
                ) : (
                  <span className={key === 'active' ? 'max-w-24 truncate' : undefined}>{menu}</span>
                )}
              </button>
              {menuOpen === menu ? (
                <MenuPopover
                  entries={entries}
                  id={menuId}
                  labelledBy={`${menuId}-trigger`}
                  onClose={() => onMenuChange(null)}
                  onMoveMenu={(delta) => moveMenu(menu, delta)}
                  returnFocus={() => triggerRefs.current.get(menu)?.focus()}
                />
              ) : null}
            </div>
          )
        })}
      </nav>
      <div aria-label="Desktop status" className="flex min-w-0 shrink-0 items-center gap-2 text-white/72 sm:gap-3">
        <span className="hidden items-center gap-1.5 lg:flex">
          <span
            aria-hidden="true"
            className={`h-1.5 w-1.5 rounded-full ${connectionWarning ? 'bg-amber-300' : 'bg-emerald-400'}`}
          />
          <span className="max-w-36 truncate">{agent.displayName}</span>
        </span>
        <span title={connectionWarning ? 'Connection degraded' : 'Connected'}>
          <Wifi aria-hidden="true" className="h-3.5 w-3.5" />
          <span className="sr-only">{connectionWarning ? 'Connection degraded' : 'Connected'}</span>
        </span>
        <span className="hidden max-w-32 truncate xl:inline">{userName || 'GitHub user'}</span>
        <time className="tabular-nums" dateTime={clock?.toISOString()}>
          {clock
            ? new Intl.DateTimeFormat(undefined, { weekday: 'short', hour: 'numeric', minute: '2-digit' }).format(clock)
            : '\u00a0'}
        </time>
      </div>
    </header>
  )
}

function MenuPopover({
  entries,
  id,
  labelledBy,
  onClose,
  onMoveMenu,
  returnFocus,
}: {
  entries: MenuEntry[]
  id: string
  labelledBy: string
  onClose: () => void
  onMoveMenu: (delta: -1 | 1) => void
  returnFocus: () => void
}) {
  const menuRef = useRef<HTMLDivElement | null>(null)

  useEffect(() => {
    menuRef.current?.querySelector<HTMLButtonElement>('button:not(:disabled)')?.focus()
  }, [])

  return (
    <div
      ref={menuRef}
      aria-labelledby={labelledBy}
      className="absolute top-[28px] left-0 min-w-56 rounded-xl border border-white/18 bg-[rgba(34,38,50,0.88)] p-1.5 shadow-2xl backdrop-blur-3xl"
      id={id}
      onKeyDown={(event) => {
        const items = [...(menuRef.current?.querySelectorAll<HTMLButtonElement>('button:not(:disabled)') ?? [])]
        const index = items.indexOf(document.activeElement as HTMLButtonElement)
        if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
          event.preventDefault()
          const delta = event.key === 'ArrowDown' ? 1 : -1
          items[(index + delta + items.length) % items.length]?.focus()
        } else if (event.key === 'Home' || event.key === 'End') {
          event.preventDefault()
          items[event.key === 'Home' ? 0 : items.length - 1]?.focus()
        } else if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
          event.preventDefault()
          onMoveMenu(event.key === 'ArrowLeft' ? -1 : 1)
        } else if (event.key === 'Escape') {
          event.preventDefault()
          onClose()
          returnFocus()
        } else if (event.key === 'Tab') {
          onClose()
        } else if (event.key.length === 1 && !event.ctrlKey && !event.metaKey && !event.altKey) {
          const match = items.find((item) => item.textContent?.trim().toLowerCase().startsWith(event.key.toLowerCase()))
          if (match) {
            event.preventDefault()
            match.focus()
          }
        }
      }}
      role="menu"
    >
      {entries.map((entry) => (
        <div className={entry.separator ? 'mt-1 border-t border-white/9 pt-1' : ''} key={entry.label}>
          <button
            className="flex w-full items-center justify-between rounded-lg px-3 py-1.5 text-left text-[12px] text-white/85 outline-none hover:bg-[#2574e8] focus-visible:bg-[#2574e8]"
            onClick={() => {
              void entry.run()
              onClose()
              returnFocus()
            }}
            role="menuitem"
            type="button"
          >
            <span>{entry.label}</span>
            <span className="ml-6 text-white/38">{entry.shortcut}</span>
          </button>
        </div>
      ))}
    </div>
  )
}

function TengriMark() {
  return (
    <span className="relative grid h-4 w-4 place-items-center rounded-full border border-white/65">
      <span className="h-1.5 w-1.5 rounded-full bg-white/85" />
      <span className="absolute -top-1 h-1.5 w-px bg-white/65" />
    </span>
  )
}
