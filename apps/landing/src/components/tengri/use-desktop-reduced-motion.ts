'use client'

import { useSyncExternalStore } from 'react'

let mediaQuery: MediaQueryList | undefined

function preference() {
  return (mediaQuery ??= window.matchMedia('(prefers-reduced-motion: reduce)'))
}

function subscribe(listener: () => void) {
  const query = preference()
  query.addEventListener('change', listener)
  return () => query.removeEventListener('change', listener)
}

const getSnapshot = () => preference().matches
const getServerSnapshot = () => true

export function useDesktopReducedMotion() {
  return useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot)
}
