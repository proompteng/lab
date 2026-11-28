export const redactCredentials = (text: string): string =>
  text
    .replace(/\b([a-z][a-z0-9+.-]*:\/\/)[^\s/?#"<>\\]*@/gi, '$1[REDACTED]@')
    .replace(/(\bauthorization["']?\s*:\s*["']?(?:bearer|basic)[ \t]+)[^\s"'`,;<>\\]+/gi, '$1[REDACTED]')
    .replace(/(\bx-access-token:[ \t]*)[^@\s"'`,;<>\\]+/gi, '$1[REDACTED]')
    .replace(/(?:gh[pousr]_|github_pat_)[a-z0-9_-]+/gi, '[REDACTED]')

export const runnerErrorMessage = (error: unknown): string =>
  redactCredentials(error instanceof Error ? error.message : String(error))

export const stringifyRunnerOutput = (value: unknown, space?: number): string =>
  JSON.stringify(
    value,
    (key, entry) => {
      if (/^(?:proxy-)?authorization$/i.test(key)) return '[REDACTED]'
      return typeof entry === 'string' ? redactCredentials(entry) : entry
    },
    space,
  )
