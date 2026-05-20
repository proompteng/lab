import { postAgentsJson, type EnvSource } from './agents-http'

export type AgentsOrchestrationRunSubmitInput = {
  deliveryId: string
  orchestrationRef: { name: string }
  namespace: string
  parameters?: Record<string, string>
  policy?: Record<string, unknown>
}

export type AgentsOrchestrationRunSubmitResult = {
  orchestrationRun: Record<string, unknown>
  resource: Record<string, unknown> | null
  idempotent: boolean
}

export const submitOrchestrationRunToAgentsService = async (
  input: AgentsOrchestrationRunSubmitInput,
  env: EnvSource = process.env,
): Promise<AgentsOrchestrationRunSubmitResult> => {
  const result = await postAgentsJson<Record<string, unknown>>(
    '/v1/orchestration-runs',
    {
      orchestrationRef: input.orchestrationRef,
      namespace: input.namespace,
      parameters: input.parameters ?? {},
      policy: input.policy ?? {},
    },
    {
      env,
      idempotencyKey: input.deliveryId,
    },
  )

  if (!result.ok) {
    const message = result.error ?? `Agents service returned HTTP ${result.status}`
    throw new Error(`Agents service orchestration submit failed (${result.status}): ${message}`)
  }

  const orchestrationRun = result.body.orchestrationRun
  if (!result.body.ok || !orchestrationRun || typeof orchestrationRun !== 'object' || Array.isArray(orchestrationRun)) {
    throw new Error('Agents service orchestration submit response did not include an orchestrationRun')
  }

  const resource =
    result.body.resource && typeof result.body.resource === 'object' && !Array.isArray(result.body.resource)
      ? (result.body.resource as Record<string, unknown>)
      : null
  return {
    orchestrationRun: orchestrationRun as Record<string, unknown>,
    resource,
    idempotent: result.body.idempotent === true,
  }
}
