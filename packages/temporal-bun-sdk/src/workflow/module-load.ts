import { AsyncLocalStorage } from 'node:async_hooks'

import type { WorkflowGuardsMode } from './guards'

type WorkflowModuleLoadContext = {
  readonly mode: WorkflowGuardsMode
}

const workflowModuleLoadStorage = new AsyncLocalStorage<WorkflowModuleLoadContext>()

export const runWithWorkflowModuleLoadContext = async <T>(
  context: WorkflowModuleLoadContext,
  fn: () => Promise<T> | T,
): Promise<T> => await workflowModuleLoadStorage.run(context, async () => await fn())

export const currentWorkflowModuleLoadContext = (): WorkflowModuleLoadContext | undefined =>
  workflowModuleLoadStorage.getStore()
