'use client'

import { useEffect } from 'react'

import { runTengriAction, TengriRequestError } from './client'

const ACTIVITY_INTERVAL_MS = 20_000

export function useDesktopActivity(agentId: string, runtimeEpoch: string, enabled: boolean) {
  useEffect(() => {
    if (!enabled) return
    const controller = new AbortController()
    let latest = 0
    let acknowledged = 0
    let pending = false
    let nextAttemptAt = 0
    let retryDelay = 1_000
    let timer: ReturnType<typeof setTimeout> | undefined

    const schedule = () => {
      if (controller.signal.aborted || pending || latest === acknowledged || timer !== undefined) return
      timer = setTimeout(
        () => {
          timer = undefined
          void send()
        },
        Math.max(0, nextAttemptAt - performance.now()),
      )
    }

    const send = async () => {
      if (controller.signal.aborted) return
      const generation = latest
      pending = true
      try {
        await runTengriAction({ action: 'record-activity', agentId }, controller.signal)
        acknowledged = generation
        retryDelay = 1_000
        nextAttemptAt = performance.now() + ACTIVITY_INTERVAL_MS
      } catch (error) {
        if (controller.signal.aborted) return
        if (
          (error instanceof DOMException && error.name === 'AbortError') ||
          (error instanceof TengriRequestError && error.status < 500 && ![408, 429].includes(error.status))
        ) {
          acknowledged = latest
          nextAttemptAt = performance.now() + ACTIVITY_INTERVAL_MS
        } else {
          nextAttemptAt = performance.now() + retryDelay
          retryDelay = Math.min(retryDelay * 2, 30_000)
        }
      } finally {
        pending = false
        schedule()
      }
    }

    const interact = (event: Event) => {
      if (!event.isTrusted || document.visibilityState !== 'visible') return
      latest += 1
      schedule()
    }
    const events = ['keydown', 'input', 'pointerdown', 'wheel'] as const
    for (const event of events) document.addEventListener(event, interact, { capture: true, passive: true })
    return () => {
      controller.abort()
      clearTimeout(timer)
      for (const event of events) document.removeEventListener(event, interact, true)
    }
  }, [agentId, runtimeEpoch, enabled])
}
