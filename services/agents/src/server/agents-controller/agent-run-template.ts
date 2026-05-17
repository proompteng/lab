import { asRecord, asString } from '../primitives'
import { RESOURCE_MAP, type KubernetesClient } from '../kube-types'

import { logAgentsControllerWarn, toLogError } from './operational-logging'
import { cancelRuntime, parseRuntimeRef } from './runtime-resources'

const AGENTRUN_TEMPLATE_ANNOTATION = 'agents.proompteng.ai/template'

type SetStatus = (
  kube: KubernetesClient,
  resource: Record<string, unknown>,
  status: Record<string, unknown>,
) => Promise<void>

type TemporalCancelClient = {
  workflow: {
    cancel: (handle: { workflowId: string; runId?: string; namespace?: string }) => Promise<void>
  }
}

type RuntimeCleanupContext = {
  kube: KubernetesClient
  namespace: string
  name: string
  status: Record<string, unknown>
  finalizer: string
  finalizers: string[]
  logContext: Record<string, unknown>
  isKubeNotFoundError: (error: unknown) => boolean
  getTemporalClient: () => Promise<unknown>
}

export const isAgentRunTemplate = (metadata: Record<string, unknown>) => {
  const annotations = asRecord(metadata.annotations) ?? {}
  return asString(annotations[AGENTRUN_TEMPLATE_ANNOTATION]) === 'true'
}

const cancelReferencedRuntime = async (input: RuntimeCleanupContext, eventName: string) => {
  const runtimeRef = parseRuntimeRef(input.status.runtimeRef)
  if (!runtimeRef) return

  try {
    await cancelRuntime({
      runtimeRef,
      namespace: input.namespace,
      kube: input.kube,
      getTemporalClient: input.getTemporalClient as () => Promise<TemporalCancelClient>,
    })
  } catch (error) {
    logAgentsControllerWarn(eventName, {
      ...input.logContext,
      ...toLogError(error),
    })
  }
}

const removeRuntimeFinalizer = async (input: RuntimeCleanupContext) => {
  try {
    await input.kube.patch(RESOURCE_MAP.AgentRun, input.name, input.namespace, {
      metadata: { finalizers: input.finalizers.filter((item) => item !== input.finalizer) },
    })
    return true
  } catch (error) {
    if (input.isKubeNotFoundError(error)) return false
    throw error
  }
}

export const reconcileAgentRunDeletion = async (input: RuntimeCleanupContext & { hasFinalizer: boolean }) => {
  if (!input.hasFinalizer) return

  await cancelReferencedRuntime(input, 'runtime_cleanup_failed')
  await removeRuntimeFinalizer(input)
}

export const reconcileAgentRunTemplate = async (
  input: RuntimeCleanupContext & {
    agentRun: Record<string, unknown>
    observedGeneration: unknown
    setStatus: SetStatus
    hasFinalizer: boolean
  },
) => {
  await cancelReferencedRuntime(input, 'template_runtime_cleanup_failed')
  if (input.hasFinalizer) {
    const patched = await removeRuntimeFinalizer(input)
    if (!patched) return
  }

  await input.setStatus(input.kube, input.agentRun, {
    observedGeneration: input.observedGeneration,
    phase: 'Template',
    conditions: [
      {
        type: 'Ready',
        status: 'True',
        reason: 'Template',
        message: 'AgentRun is a reusable schedule template and is not submitted directly',
      },
    ],
  })
}
