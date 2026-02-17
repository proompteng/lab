import type { ReactNode } from 'react'

import TerminalWindow from '@/components/terminal-window'
import { cn } from '@/lib/utils'

function DockIcon({ className, label, children }: { className?: string; label: string; children: ReactNode }) {
  return (
    <button
      type="button"
      aria-label={label}
      className={cn(
        'relative flex size-11 items-center justify-center rounded-2xl border border-white/10 bg-white/5 text-white/80 shadow-[0_18px_40px_-18px_rgba(0,0,0,0.85)]',
        'transition hover:-translate-y-0.5 hover:bg-white/10 hover:text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-400/60',
        className,
      )}
    >
      {children}
    </button>
  )
}

export default function DesktopHero() {
  return (
    <div className="relative min-h-[100svh] overflow-hidden">
      <div className="pointer-events-none absolute inset-0 bg-[radial-gradient(900px_620px_at_16%_10%,rgba(34,197,94,0.20),transparent_58%),radial-gradient(720px_520px_at_84%_16%,rgba(56,189,248,0.18),transparent_60%),radial-gradient(840px_620px_at_40%_96%,rgba(244,63,94,0.12),transparent_58%),linear-gradient(180deg,#050506,#0b0b10)]" />
      <div className="pointer-events-none absolute inset-0 opacity-70 [background-image:linear-gradient(to_right,rgba(255,255,255,0.05)_1px,transparent_1px),linear-gradient(to_bottom,rgba(255,255,255,0.04)_1px,transparent_1px)] [background-size:72px_72px]" />
      <div className="pointer-events-none absolute inset-0 bg-[radial-gradient(circle_at_50%_40%,rgba(255,255,255,0.06),transparent_55%)]" />

      <div className="relative flex min-h-[100svh] flex-col">
        <div className="flex items-center justify-between px-4 py-3 sm:px-6">
          <div className="flex items-center gap-3">
            <div className="flex items-center gap-1">
              <span className="size-2 rounded-full bg-rose-400/80" />
              <span className="size-2 rounded-full bg-amber-300/80" />
              <span className="size-2 rounded-full bg-emerald-400/80" />
            </div>
            <p className="font-mono text-xs tracking-[0.22em] text-white/70">proompteng.ai</p>
          </div>
          <div className="flex items-center gap-3 text-xs text-white/60">
            <span className="hidden font-mono sm:inline">agents-prod</span>
            <span className="rounded-full border border-white/10 bg-white/5 px-2 py-1 font-mono">LIVE</span>
          </div>
        </div>

        <div className="flex flex-1 items-center justify-center px-4 py-10 sm:px-8">
          <TerminalWindow className="w-full max-w-5xl" />
        </div>

        <div className="hidden px-6 pb-6 sm:block">
          <div className="mx-auto flex w-fit items-center gap-2 rounded-[2.25rem] border border-white/10 bg-white/5 p-2 shadow-[0_30px_80px_-36px_rgba(0,0,0,0.9)] backdrop-blur">
            <DockIcon label="Terminal" className="bg-emerald-500/15 text-emerald-100">
              <svg viewBox="0 0 24 24" aria-hidden="true" className="size-5">
                <path
                  fill="currentColor"
                  d="M4 5.5A2.5 2.5 0 0 1 6.5 3h11A2.5 2.5 0 0 1 20 5.5v13A2.5 2.5 0 0 1 17.5 21h-11A2.5 2.5 0 0 1 4 18.5v-13Zm4.2 5.15a.9.9 0 0 1 0 1.27l-1.83 1.83 1.83 1.83a.9.9 0 1 1-1.27 1.27l-2.46-2.46a.9.9 0 0 1 0-1.27l2.46-2.46a.9.9 0 0 1 1.27 0ZM11 16.5a.9.9 0 0 1 .9-.9h5a.9.9 0 1 1 0 1.8h-5a.9.9 0 0 1-.9-.9Z"
                />
              </svg>
            </DockIcon>
            <DockIcon label="Docs">
              <svg viewBox="0 0 24 24" aria-hidden="true" className="size-5">
                <path
                  fill="currentColor"
                  d="M7 3.75A2.75 2.75 0 0 1 9.75 1h9.5A2.75 2.75 0 0 1 22 3.75v15.5A2.75 2.75 0 0 1 19.25 22h-9.5A2.75 2.75 0 0 1 7 19.25v-.8c-.33.1-.68.15-1.05.15H4.75A2.75 2.75 0 0 1 2 15.85v-9.1A2.75 2.75 0 0 1 4.75 4h1.2c.37 0 .72.05 1.05.15v-.4Zm2.75-.95a.95.95 0 0 0-.95.95v15.5c0 .52.43.95.95.95h9.5c.52 0 .95-.43.95-.95V3.75a.95.95 0 0 0-.95-.95h-9.5ZM4.75 5.8a.95.95 0 0 0-.95.95v9.1c0 .52.43.95.95.95h1.2c.58 0 1.05-.47 1.05-1.05V6.85c0-.58-.47-1.05-1.05-1.05h-1.2Z"
                />
              </svg>
            </DockIcon>
            <DockIcon label="Status">
              <svg viewBox="0 0 24 24" aria-hidden="true" className="size-5">
                <path
                  fill="currentColor"
                  d="M12 2a10 10 0 1 1 0 20 10 10 0 0 1 0-20Zm0 2a8 8 0 1 0 0 16 8 8 0 0 0 0-16Zm0 3.5a1 1 0 0 1 1 1V12a1 1 0 0 1-.3.71l-2 2a1 1 0 1 1-1.4-1.42L11 11.59V8.5a1 1 0 0 1 1-1Z"
                />
              </svg>
            </DockIcon>
            <DockIcon label="Settings">
              <svg viewBox="0 0 24 24" aria-hidden="true" className="size-5">
                <path
                  fill="currentColor"
                  d="M12 8.25a3.75 3.75 0 1 1 0 7.5 3.75 3.75 0 0 1 0-7.5Zm9.1 3.2-.92-.53.06-1.06a1.8 1.8 0 0 0-.67-1.52l-1.2-1a1.8 1.8 0 0 0-1.6-.38l-1.02.26-.63-.9a1.8 1.8 0 0 0-1.5-.76h-1.5a1.8 1.8 0 0 0-1.5.76l-.63.9-1.02-.26a1.8 1.8 0 0 0-1.6.38l-1.2 1a1.8 1.8 0 0 0-.67 1.52l.06 1.06-.92.53A1.8 1.8 0 0 0 2 13.2v1.6c0 .64.34 1.24.9 1.57l.92.53-.06 1.06c-.05.64.19 1.27.67 1.52l1.2 1c.46.39 1.1.52 1.6.38l1.02-.26.63.9c.34.49.9.76 1.5.76h1.5c.6 0 1.16-.27 1.5-.76l.63-.9 1.02.26c.5.14 1.14 0 1.6-.38l1.2-1c.48-.25.72-.88.67-1.52l-.06-1.06.92-.53c.56-.33.9-.93.9-1.57v-1.6c0-.64-.34-1.24-.9-1.57ZM12 10.05a1.95 1.95 0 1 0 0 3.9 1.95 1.95 0 0 0 0-3.9Z"
                />
              </svg>
            </DockIcon>
          </div>
        </div>
      </div>
    </div>
  )
}
