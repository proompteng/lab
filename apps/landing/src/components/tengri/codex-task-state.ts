import { codexRunIsTerminal, type TengriCodexRun } from '@/lib/tengri/codex-run'

export type CodexRunObservation = {
  submittedAtMs?: number
  lastCheckedAtMs?: number
  lastUpdateReceivedAtMs?: number
}

export function codexRunCanStop(
  run: TengriCodexRun | null,
  identity: { agentId: string; threadId: string; runId: string },
) {
  return Boolean(
    run &&
    run.agentId === identity.agentId &&
    run.threadId === identity.threadId &&
    run.runId === identity.runId &&
    !codexRunIsTerminal(run),
  )
}

export function codexTaskState(state: TengriCodexRun['state']) {
  const reason = 'reason' in state ? state.reason : undefined
  switch (state.phase) {
    case 'accepted':
      return { label: 'Queued', description: 'Your request was accepted and is waiting to start.' }
    case 'waiting_for_guest':
      return {
        label: 'Preparing workspace',
        description: reason?.includes('automatic sleep')
          ? 'Keeping the workspace awake before starting your task.'
          : 'Waiting for the workspace to become available. Your request is retained.',
        reason,
      }
    case 'running':
      return { label: 'Working', description: 'The agent is working on this task.' }
    case 'waiting_for_approval':
      return { label: 'Approval needed', description: 'Review the requested action in Chat to continue.' }
    case 'recovering':
      return {
        label: 'Recovering task',
        description: reason?.includes('recorded turn outcome')
          ? 'Checking the recorded outcome before continuing. The request will not be sent again.'
          : reason?.includes('pending controls')
            ? 'Recovering a pending approval or control request.'
            : 'Reconnecting to the existing task. Its outcome has not been confirmed.',
        reason,
      }
    case 'cancelling':
      return {
        label: 'Stop requested',
        description: reason?.includes('paused')
          ? 'Resume the workspace in Power & Sleep to confirm that the task has stopped.'
          : reason?.includes('cleanup')
            ? 'Waiting for running commands to finish stopping.'
            : 'Waiting for the agent to confirm that the task has stopped.',
        reason,
      }
    case 'needs_reconciliation':
      return {
        label: 'Review needed',
        description:
          'The last action could not be confirmed. Inspect the conversation and results before retrying work.',
        reason,
      }
    case 'succeeded':
      return { label: 'Completed', description: 'The agent finished this task. Review its response and results.' }
    case 'cancelled':
      return { label: 'Stopped', description: 'The agent confirmed that the task has stopped.' }
    case 'failed':
      return {
        label: 'Failed',
        description: 'The task ended with an error. Review the details before trying again.',
        reason,
      }
    case 'rejected':
      return {
        label: 'Not started',
        description: 'The request was rejected before execution. Review the details.',
        reason,
      }
  }
}

export function elapsedSinceSubmission(submittedAtMs: number, now: number) {
  const seconds = Math.max(0, Math.floor((now - submittedAtMs) / 1000))
  if (seconds < 60) return `${seconds}s`
  const minutes = Math.floor(seconds / 60)
  return minutes < 60 ? `${minutes}m ${seconds % 60}s` : `${Math.floor(minutes / 60)}h ${minutes % 60}m`
}
