'use client'

import type { KeyboardEvent as ReactKeyboardEvent } from 'react'
import { useCallback, useEffect, useRef } from 'react'

export function useModalFocus<Element extends HTMLElement>(enabled = true) {
  const ref = useRef<Element | null>(null)

  useEffect(() => {
    if (!enabled) return
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null
    const container = ref.current
    const first = modalFocusableElements(container)[0]
    ;(first || container)?.focus()
    return () => {
      if (previous?.isConnected) previous.focus()
    }
  }, [enabled])

  const onKeyDown = useCallback((event: ReactKeyboardEvent<Element>) => {
    if (event.key !== 'Tab') return
    const focusable = modalFocusableElements(ref.current)
    if (!focusable.length) {
      event.preventDefault()
      ref.current?.focus()
      return
    }
    const first = focusable[0]
    const last = focusable.at(-1)
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault()
      last?.focus()
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault()
      first?.focus()
    }
  }, [])

  return { ref, onKeyDown }
}

function modalFocusableElements(container: HTMLElement | null) {
  if (!container) return []
  return [
    ...container.querySelectorAll<HTMLElement>(
      'a[href], button:not(:disabled), input:not(:disabled), textarea:not(:disabled), select:not(:disabled), [tabindex]:not([tabindex="-1"])',
    ),
  ].filter(
    (element) =>
      !element.hasAttribute('hidden') && element.getAttribute('aria-hidden') !== 'true' && !element.closest('[inert]'),
  )
}
