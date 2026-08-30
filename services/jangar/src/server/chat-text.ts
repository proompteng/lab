export const safeJsonStringify = (value: unknown) => {
  try {
    return JSON.stringify(value)
  } catch {
    return String(value)
  }
}

export const stripTerminalControl = (text: string) => {
  if (text.length === 0) return text

  // Some clients (and copy/paste flows) will include U+241B (SYMBOL FOR ESCAPE) instead of a raw ESC.
  const input = text.replaceAll('\u241b', '\u001b')
  const esc = '\u001b'
  const csi = '\u009b'
  const bel = '\u0007'

  let output = ''

  for (let index = 0; index < input.length; index += 1) {
    const char = input[index]

    if (char !== esc && char !== csi) {
      // Drop non-printable control characters (keep \t, \n, \r).
      if (char <= '\u001f' || char === '\u007f') {
        if (char === '\n' || char === '\r' || char === '\t') output += char
        continue
      }

      output += char
      continue
    }

    // Treat CSI (0x9B) like ESC [.
    const next = char === csi ? '[' : input[index + 1]

    // If we have a bare ESC at end, drop it.
    if (char === esc && next == null) break

    // OSC / DCS / PM / APC / SOS: skip until BEL or ST (ESC \).
    if (next === ']' || next === 'P' || next === '^' || next === '_' || next === 'X') {
      index += char === esc ? 1 : 0
      for (index += 1; index < input.length; index += 1) {
        const inner = input[index]
        if (inner === bel) break
        if (inner === esc && input[index + 1] === '\\') {
          index += 1
          break
        }
      }
      continue
    }

    // CSI: skip until a final byte in the range @..~.
    if (next === '[') {
      index += char === esc ? 1 : 0
      for (index += 1; index < input.length; index += 1) {
        const code = input.charCodeAt(index)
        if (code >= 0x40 && code <= 0x7e) break
      }
      continue
    }

    // Other short ESC sequences: drop ESC and one following byte (if present).
    if (char === esc) index += 1
  }

  return output
}
