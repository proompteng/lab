'use client'

import { Wifi } from 'lucide-react'
import { useEffect, useRef } from 'react'
import type { TengriAgent } from '@/lib/tengri/types'
import { DOCK_APPS } from './desktop-apps'
import { APP_TITLES, type TengriApp } from './window-manager'

type MenuEntry = {
  label: string
  shortcut?: string
  run?: () => void | Promise<void>
  separator?: boolean
}

export function MenuBar({
  activeApp,
  agent,
  clock,
  menuOpen,
  onMenuChange,
  onCloseActive,
  onMinimizeActive,
  onNewWindow,
  onOpenApp,
  onOpenSpotlight,
  onToggleMaximize,
  onSignOut,
  userName,
}: {
  activeApp: TengriApp
  agent: TengriAgent | null
  clock: Date | null
  menuOpen: string | null
  onMenuChange: (menu: string | null) => void
  onCloseActive: () => void
  onMinimizeActive: () => void
  onNewWindow: () => void
  onOpenApp: (app: TengriApp) => void
  onOpenSpotlight: () => void
  onToggleMaximize: () => void
  onSignOut: () => void
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
      { label: 'Tengri Help', run: () => window.open('https://docs.proompteng.ai', '_blank', 'noopener,noreferrer') },
    ],
  }
  const menuNames = ['tengri', APP_TITLES[activeApp], 'File', 'Edit', 'View', 'Window', 'Help']
  const focusMenu = (menu: string) => window.requestAnimationFrame(() => triggerRefs.current.get(menu)?.focus())
  const moveMenu = (currentMenu: string, delta: -1 | 1) => {
    const current = menuNames.indexOf(currentMenu)
    const next = menuNames[(current + delta + menuNames.length) % menuNames.length]
    if (!next) return
    onMenuChange(menuOpen ? next : null)
    focusMenu(next)
  }

  return (
    <header className="tengri-menubar absolute inset-x-0 top-0 z-[2000] flex h-[30px] items-center justify-between border-b border-white/10 px-3 text-[12px] shadow-sm backdrop-blur-2xl">
      <nav role="menubar" className="flex h-full items-center gap-0.5" aria-label="Application menu">
        {menuNames.map((menu, index) => {
          const key = menu === APP_TITLES[activeApp] ? 'active' : menu
          const entries = menus[menu]
          const menuId = `tengri-menu-${key.toLowerCase().replaceAll(' ', '-')}`
          return (
            <div className="relative h-full" key={key}>
              <button
                ref={(element) => {
                  if (element) triggerRefs.current.set(menu, element)
                  else triggerRefs.current.delete(menu)
                }}
                type="button"
                role="menuitem"
                id={`${menuId}-trigger`}
                tabIndex={index === 0 ? 0 : -1}
                className={`flex h-full items-center rounded px-2 text-white/82 hover:bg-white/10 ${key === 'active' ? 'font-semibold' : ''}`}
                aria-label={menu === 'tengri' ? 'Tengri menu' : undefined}
                aria-expanded={menuOpen === menu}
                aria-haspopup="menu"
                aria-controls={menuId}
                onFocus={(event) => rememberEditTarget(event.relatedTarget)}
                onPointerDown={() => rememberEditTarget(document.activeElement)}
                onPointerEnter={() => {
                  if (menuOpen && menuOpen !== menu) onMenuChange(menu)
                }}
                onClick={(event) => {
                  event.stopPropagation()
                  onMenuChange(menuOpen === menu ? null : menu)
                }}
                onKeyDown={(event) => {
                  if (event.key === 'ArrowDown' || event.key === 'Enter' || event.key === ' ') {
                    event.preventDefault()
                    onMenuChange(menu)
                  } else if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
                    event.preventDefault()
                    moveMenu(menu, event.key === 'ArrowLeft' ? -1 : 1)
                  } else if (event.key === 'Home' || event.key === 'End') {
                    event.preventDefault()
                    focusMenu(event.key === 'Home' ? menuNames[0]! : menuNames.at(-1)!)
                  } else if (event.key === 'Escape') {
                    event.preventDefault()
                    onMenuChange(null)
                  }
                }}
              >
                {menu === 'tengri' ? <TengriMark /> : menu}
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
      <div className="flex h-full items-center gap-3 text-white/76">
        {agent ? (
          <span className="flex items-center gap-1.5">
            <span
              aria-hidden="true"
              className={`h-1.5 w-1.5 rounded-full ${agent.phase === 'ready' ? 'bg-emerald-400' : 'bg-amber-300'}`}
            />
            {agent.displayName}
          </span>
        ) : null}
        <span title="Connected">
          <Wifi aria-hidden="true" className="h-3.5 w-3.5" />
          <span className="sr-only">Connected</span>
        </span>
        {userName ? <span className="max-w-32 truncate">{userName}</span> : null}
        <time dateTime={clock?.toISOString()}>
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
      id={id}
      role="menu"
      aria-labelledby={labelledBy}
      className="tengri-menu absolute top-[28px] left-0 min-w-56 rounded-xl border border-white/18 p-1.5 shadow-2xl backdrop-blur-3xl"
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
    >
      {entries.map((entry) => (
        <div key={entry.label} className={entry.separator ? 'mt-1 border-t border-white/9 pt-1' : ''}>
          <button
            type="button"
            role="menuitem"
            className="flex w-full items-center justify-between rounded-lg px-3 py-1.5 text-left text-[12px] text-white/85 hover:bg-[#2574e8] disabled:text-white/28"
            disabled={!entry.run}
            onClick={() => {
              void entry.run?.()
              onClose()
            }}
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
