import type { WorkerTaskInput, WorkerTaskResult } from '../types/activities'

export const runWorkerTaskActivity = async (input: WorkerTaskInput): Promise<WorkerTaskResult> => {
  // TODO(jng-040a): clone repo, run worker Codex, lint/test, push branch, open PR
  return {
    branch: `auto/${input.task}`,
    notes: 'TODO(worker task result)',
  }
}
