'use client'

import { useQuery } from 'convex/react'
import { makeFunctionReference } from 'convex/server'
import { LIVE_PRESENCE_ENABLED, LIVE_PRESENCE_SITE } from '@/lib/live-presence'

const convexUrl = process.env.NEXT_PUBLIC_CONVEX_URL
const getOnlineNowQuery = makeFunctionReference<'query'>('presence:getOnlineNow')

export default function LiveOnlineCounter() {
  if (!LIVE_PRESENCE_ENABLED || !convexUrl) {
    return null
  }

  return <LiveOnlineCounterValue />
}

function LiveOnlineCounterValue() {
  const result = useQuery(getOnlineNowQuery, { site: LIVE_PRESENCE_SITE })
  const onlineNow = result?.onlineNow

  return (
    <div className="inline-flex items-center gap-1.5 rounded-full border border-[rgb(var(--terminal-shell-border)/0.5)] bg-[rgb(var(--terminal-window-bg-top)/0.66)] px-2.5 py-1 text-[10px] tracking-[0.08em] text-[rgb(var(--terminal-text-faint)/0.88)] shadow-[inset_0_1px_0_rgba(255,255,255,0.04)] backdrop-blur">
      <span className="relative inline-flex size-2">
        <span className="absolute inline-flex size-2 animate-ping rounded-full bg-[rgb(var(--terminal-text-green)/0.8)]" />
        <span className="relative inline-flex size-2 rounded-full bg-[rgb(var(--terminal-text-green))]" />
      </span>
      <span className="font-semibold uppercase text-[rgb(var(--terminal-text-green)/0.95)]">Live</span>
      <span className="font-medium text-[rgb(var(--terminal-text-primary)/0.88)]">
        {onlineNow === undefined ? '--' : onlineNow} online
      </span>
    </div>
  )
}
