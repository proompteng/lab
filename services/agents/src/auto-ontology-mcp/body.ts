export class BodyTooLargeError extends Error {}

export const readBoundedText = async (message: Request | Response, maxBytes: number, signal: AbortSignal) => {
  if (Number(message.headers.get('content-length')) > maxBytes) {
    void message.body?.cancel().catch(() => undefined)
    throw new BodyTooLargeError()
  }
  if (!message.body) return ''
  const reader = message.body.getReader()
  const decoder = new TextDecoder('utf-8', { fatal: true })
  const cancel = () => void reader.cancel().catch(() => undefined)
  signal.addEventListener('abort', cancel, { once: true })
  let bytes = 0
  let text = ''
  try {
    while (true) {
      signal.throwIfAborted()
      const chunk = await reader.read()
      signal.throwIfAborted()
      if (chunk.done) return text + decoder.decode()
      bytes += chunk.value.byteLength
      if (bytes > maxBytes) throw new BodyTooLargeError()
      text += decoder.decode(chunk.value, { stream: true })
    }
  } catch (error) {
    cancel()
    throw error
  } finally {
    signal.removeEventListener('abort', cancel)
    reader.releaseLock()
  }
}
