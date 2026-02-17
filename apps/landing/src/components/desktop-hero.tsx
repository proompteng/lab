import TerminalWindow from '@/components/terminal-window'

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
      </div>
    </div>
  )
}
