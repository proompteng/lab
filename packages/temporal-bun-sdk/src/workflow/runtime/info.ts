import type { coresdk } from '@temporalio/proto'
import type { ParentWorkflowInfo, RootWorkflowInfo } from '@temporalio/common'
import { IllegalStateError } from '@temporalio/workflow'

export const convertParentWorkflowInfo = (
  parent: coresdk.common.INamespacedWorkflowExecution | null | undefined,
): ParentWorkflowInfo | undefined => {
  if (!parent) {
    return undefined
  }

  const { workflowId, runId, namespace } = parent
  if (!workflowId || !runId || !namespace) {
    throw new IllegalStateError('Parent workflow execution is missing required fields')
  }

  return { workflowId, runId, namespace }
}

export const convertRootWorkflowInfo = (
  root: coresdk.common.IWorkflowExecution | null | undefined,
): RootWorkflowInfo | undefined => {
  if (!root) {
    return undefined
  }

  const { workflowId, runId } = root
  if (!workflowId || !runId) {
    throw new IllegalStateError('Root workflow execution is missing required fields')
  }

  return { workflowId, runId }
}
