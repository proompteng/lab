import type { WorkerTaskInput, WorkerTaskResult } from '../types/activities'

export const runWorkerTaskActivity = async (input: WorkerTaskInput): Promise<WorkerTaskResult> => {
  // TODO(jng-040a): clone repo, run worker Codex, lint/test, push branch, open PR
  return {
    prUrl: undefined,
    branch: `auto/${input.task}`,
    commitSha: undefined,
    notes: 'TODO(worker task result)',
  }
}
