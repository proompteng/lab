type EventStreamHandlers = {
  onOpen(): void
  onMessage(message: MessageEvent<string>): void
  onError(): void
}

export function watchTengriEvents(url: () => string, handlers: EventStreamHandlers) {
  let source: EventSource | undefined
  let retry: ReturnType<typeof setTimeout> | undefined
  let retryDelay = 1_000
  let stopped = false

  const connect = () => {
    if (stopped) return
    const current = new EventSource(url())
    source = current
    current.onopen = () => {
      if (stopped || source !== current) return
      retryDelay = 1_000
      handlers.onOpen()
    }
    current.onmessage = (message) => {
      if (!stopped && source === current) handlers.onMessage(message)
    }
    current.onerror = () => {
      if (stopped || source !== current) return
      handlers.onError()
      if (current.readyState !== EventSource.CLOSED) return
      source = undefined
      current.close()
      retry = setTimeout(connect, retryDelay)
      retryDelay = Math.min(retryDelay * 2, 30_000)
    }
  }
  connect()
  return () => {
    stopped = true
    clearTimeout(retry)
    source?.close()
  }
}
