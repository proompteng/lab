'use client'

import { CodeXml, PanelLeft, Settings, TerminalSquare } from 'lucide-react'
import { motion } from 'motion/react'
import { DOCK_APPS } from './desktop-apps'
import { APP_TITLES, type TengriApp } from './window-manager'

export function Dock({
  activeApp,
  onOpen,
  windows,
}: {
  activeApp: TengriApp
  onOpen: (app: TengriApp) => void
  windows: Array<{ app: TengriApp; mode: string }>
}) {
  return (
    <div className="pointer-events-none absolute inset-x-0 bottom-3 z-[1500] flex justify-center">
      <nav
        className="tengri-dock pointer-events-auto flex h-[72px] items-end gap-2 rounded-[24px] border border-white/20 px-3 pb-2 shadow-[0_20px_60px_rgba(0,0,0,0.42),inset_0_1px_0_rgba(255,255,255,0.2)] backdrop-blur-3xl"
        aria-label="Dock"
      >
        {DOCK_APPS.map((app) => {
          const running = windows.some((window) => window.app === app)
          return (
            <motion.button
              type="button"
              aria-label={`Open ${APP_TITLES[app]}`}
              className="group relative flex flex-col items-center"
              key={app}
              onClick={() => onOpen(app)}
              whileHover={{ y: -10, scale: 1.28 }}
              whileTap={{ scale: 0.95 }}
              transition={{ type: 'spring', stiffness: 520, damping: 28 }}
            >
              <span className="pointer-events-none absolute -top-10 rounded-md border border-white/10 bg-black/65 px-2 py-1 text-[10px] text-white opacity-0 backdrop-blur-md transition-opacity group-hover:opacity-100 group-focus-visible:opacity-100">
                {APP_TITLES[app]}
              </span>
              <AppIcon app={app} />
              <span
                aria-hidden="true"
                className={`mt-1 h-1 w-1 rounded-full ${running ? (activeApp === app ? 'bg-white' : 'bg-white/55') : 'bg-transparent'}`}
              />
            </motion.button>
          )
        })}
      </nav>
    </div>
  )
}

function AppIcon({ app }: { app: TengriApp }) {
  const shared =
    'grid h-[48px] w-[48px] place-items-center overflow-hidden rounded-[13px] border border-white/20 shadow-[0_9px_22px_rgba(0,0,0,0.35),inset_0_1px_0_rgba(255,255,255,0.35)]'
  if (app === 'finder')
    return (
      <span className={`${shared} relative bg-gradient-to-br from-[#79c4ff] to-[#1976d2]`}>
        <PanelLeft className="h-7 w-7 text-white/90" />
        <span className="absolute inset-y-0 left-1/2 w-px bg-black/14" />
      </span>
    )
  if (app === 'chrome')
    return (
      <span
        className={shared}
        style={{
          background: 'conic-gradient(from -34deg, #e84b47 0deg 116deg, #efcb4c 116deg 236deg, #43a765 236deg)',
        }}
      >
        <span className="h-5 w-5 rounded-full border-[5px] border-white/85 bg-[#2574e8]" />
      </span>
    )
  if (app === 'code')
    return (
      <span className={`${shared} bg-gradient-to-br from-[#51a8ff] to-[#145fbd]`}>
        <CodeXml className="h-7 w-7 text-white" />
      </span>
    )
  if (app === 'terminal')
    return (
      <span className={`${shared} bg-gradient-to-br from-[#313642] to-[#090b0f]`}>
        <TerminalSquare className="h-7 w-7 text-[#d8dee9]" />
      </span>
    )
  return (
    <span className={`${shared} bg-gradient-to-br from-[#aeb8c8] to-[#596273]`}>
      <Settings className="h-7 w-7 text-white" />
    </span>
  )
}
