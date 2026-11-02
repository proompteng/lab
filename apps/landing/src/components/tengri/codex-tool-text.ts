/* oxlint-disable no-control-regex -- Removing terminal control sequences requires matching their control bytes. */
// Tool transcripts are text, not terminal emulators. Strip control sequences
// before rendering; unwrap a complete JSON string once without interpreting code.
export function codexToolText(value: string): string {
  let text = value
  const trimmed = text.trim()
  if (trimmed.startsWith('"') && trimmed.endsWith('"')) {
    try {
      const decoded: unknown = JSON.parse(trimmed)
      if (typeof decoded === 'string') text = decoded
    } catch {
      // Truncated or ordinary quoted output remains literal.
    }
  }
  return text
    .replace(/\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)/g, '')
    .replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, '')
    .replace(/\r\n?/g, '\n')
}
