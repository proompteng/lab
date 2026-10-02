const lastFocusedContent = new WeakMap<HTMLElement, HTMLElement>()

export function rememberWindowFocus(frame: HTMLElement, target: EventTarget | null) {
  if (target instanceof HTMLElement && target !== frame && !target.closest('[aria-label="Window controls"]')) {
    lastFocusedContent.set(frame, target)
  }
}

export function focusWindowContent(frame: HTMLElement | null) {
  if (!frame || frame.closest('[inert]') || frame.inert || document.querySelector('[data-tengri-modal="true"]')) return
  if (frame.contains(document.activeElement)) return
  const previous = lastFocusedContent.get(frame)
  const available = (element: HTMLElement) =>
    frame.contains(element) &&
    !element.matches(':disabled') &&
    !element.closest('[hidden], [inert]') &&
    element.getClientRects().length > 0
  if (previous && available(previous)) {
    previous.focus({ preventScroll: true })
    return
  }
  const defaults = [...frame.querySelectorAll<HTMLElement>('[data-window-default-focus]')]
  ;(defaults.find(available) ?? frame).focus({ preventScroll: true })
}
