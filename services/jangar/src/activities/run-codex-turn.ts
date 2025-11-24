import type { RunCodexTurnInput, RunCodexTurnResult } from '../types/activities'

export const runCodexTurnActivity = async (input: RunCodexTurnInput): Promise<RunCodexTurnResult> => {
  // TODO(jng-030a): implement Codex meta turn execution + snapshot persistence
  return {
    threadId: input.threadId ?? null,
    finalResponse: 'TODO(meta turn result)',
    items: [],
    usage: null,
    events: [],
    createdAt: new Date().toISOString(),
  }
}
