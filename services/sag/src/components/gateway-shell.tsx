import { ArrowDownToLine, ShieldCheck } from 'lucide-react'
import type { ReactNode } from 'react'
import { Separator } from '~/components/base-ui'
import type { GatewaySnapshot } from '~/server/gateway'

const navItems = [
  ['Dashboard', '/'],
  ['Events', '/events'],
  ['Rules', '/rules'],
  ['AgentRuns', '/agents'],
  ['Connectors', '/connectors'],
  ['Approvals', '/approvals'],
] as const

export function GatewayFrame({
  active,
  snapshot,
  children,
}: {
  active: string
  snapshot: GatewaySnapshot
  children: ReactNode
}) {
  return (
    <main id="main-content" className="flex h-screen min-h-[720px] flex-col bg-zinc-950 text-zinc-100">
      <header className="flex h-12 shrink-0 items-center justify-between border-b border-zinc-800 px-5">
        <div className="flex min-w-0 items-center gap-4">
          <a href="/" className="flex min-w-0 items-center gap-3">
            <div className="flex size-7 items-center justify-center rounded-md border border-zinc-800 bg-zinc-900">
              <ShieldCheck className="size-4 text-zinc-100" aria-hidden="true" />
            </div>
            <h1 className="truncate text-sm font-semibold text-zinc-50">Secure Action Gateway</h1>
          </a>
          <nav className="hidden items-center gap-1 lg:flex">
            {navItems.map(([label, href]) => (
              <a
                key={href}
                href={href}
                className={
                  active === href
                    ? 'rounded-md bg-zinc-900 px-2 py-1 text-xs font-medium text-zinc-100'
                    : 'rounded-md px-2 py-1 text-xs font-medium text-zinc-500 hover:bg-zinc-900 hover:text-zinc-200'
                }
              >
                {label}
              </a>
            ))}
          </nav>
        </div>
        <div className="flex items-center gap-3 text-xs text-zinc-500">
          <span>{snapshot.stats.totalAgentRuns} AgentRuns</span>
          <Separator orientation="vertical" className="h-4" />
          <span>{snapshot.stats.totalEvents} events</span>
          <Separator orientation="vertical" className="h-4" />
          <span>{snapshot.stats.blockedAgentRuns} blocked</span>
          <a
            href="/api/events/export"
            className="inline-flex h-7 items-center gap-1.5 rounded-md border border-zinc-800 px-2 text-xs font-medium text-zinc-200 hover:bg-zinc-900"
          >
            <ArrowDownToLine className="size-3.5" aria-hidden="true" />
            JSONL
          </a>
        </div>
      </header>
      {children}
    </main>
  )
}
