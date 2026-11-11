import type { TengriCodexEvent } from './types'

const LOG_DATABASE_WARNING =
  "Codex couldn't save diagnostic logs to its local database. Use /feedback with logs included before closing Codex, or run `codex doctor` for diagnostics."

export function isCodexDiagnosticLogWarning(event: Pick<TengriCodexEvent, 'kind' | 'method' | 'threadId' | 'text'>) {
  return (
    event.kind === 'warning' && event.method === 'warning' && !event.threadId && event.text === LOG_DATABASE_WARNING
  )
}
