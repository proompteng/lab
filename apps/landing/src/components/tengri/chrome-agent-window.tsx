'use client'

import { ArrowLeft, ArrowRight, Bot, RotateCw, ShieldCheck } from 'lucide-react'
import { useState } from 'react'

import { AgentChat } from './agent-chat'

export function ChromeAgentWindow({ agentId }: { agentId: string }) {
  const [reloadKey, setReloadKey] = useState(0)

  return (
    <div className="flex h-full min-h-0 flex-col bg-[#11141b]">
      <div className="flex h-9 shrink-0 items-end border-b border-black/35 bg-[#1b1e26] px-2">
        <div className="flex h-8 min-w-0 max-w-64 items-center gap-2 rounded-t-xl border border-white/8 border-b-[#242832] bg-[#242832] px-3 text-xs text-white/78">
          <span className="grid h-4 w-4 shrink-0 place-items-center rounded-full bg-gradient-to-br from-[#4e9dff] to-[#7659e8]">
            <Bot aria-hidden="true" className="h-2.5 w-2.5 text-white" />
          </span>
          <span className="truncate">Tengri Agent</span>
        </div>
      </div>
      <div className="flex h-11 shrink-0 items-center gap-1.5 border-b border-black/30 bg-[#242832] px-2.5">
        <button
          type="button"
          aria-label="Back"
          disabled
          className="grid h-8 w-8 place-items-center rounded-full text-white/25 disabled:cursor-default"
        >
          <ArrowLeft aria-hidden="true" className="h-4 w-4" />
        </button>
        <button
          type="button"
          aria-label="Forward"
          disabled
          className="grid h-8 w-8 place-items-center rounded-full text-white/25 disabled:cursor-default"
        >
          <ArrowRight aria-hidden="true" className="h-4 w-4" />
        </button>
        <button
          type="button"
          aria-label="Reload agent chat"
          className="grid h-8 w-8 place-items-center rounded-full text-white/62 outline-none hover:bg-white/8 hover:text-white/88 focus-visible:ring-2 focus-visible:ring-white/55"
          onClick={() => setReloadKey((current) => current + 1)}
        >
          <RotateCw aria-hidden="true" className="h-4 w-4" />
        </button>
        <div className="flex h-8 min-w-0 flex-1 items-center gap-2 rounded-full border border-white/7 bg-black/20 px-3 text-xs text-white/58 shadow-inner">
          <ShieldCheck aria-hidden="true" className="h-3.5 w-3.5 shrink-0 text-emerald-300/72" />
          <span className="truncate font-mono">tengri://agent</span>
        </div>
      </div>
      <div className="min-h-0 flex-1">
        <AgentChat key={reloadKey} agentId={agentId} />
      </div>
    </div>
  )
}
