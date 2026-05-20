import type { AgentsServiceJsonResult, EnvSource } from './agents-service-client'
import {
  fetchControlPlaneResourceFromAgentsService,
  type AgentsControlPlaneResourceResult,
  type AgentsNamedControlPlaneResourceInput,
} from './control-plane-resource-transport'

export type { AgentsControlPlaneResourceResult, AgentsNamedControlPlaneResourceInput }

export const fetchApprovalPolicyResourceFromAgentsService = async (
  input: AgentsNamedControlPlaneResourceInput,
  env: EnvSource = process.env,
): Promise<AgentsServiceJsonResult<AgentsControlPlaneResourceResult>> =>
  fetchControlPlaneResourceFromAgentsService({ kind: 'ApprovalPolicy', ...input }, env)

export const fetchBudgetResourceFromAgentsService = async (
  input: AgentsNamedControlPlaneResourceInput,
  env: EnvSource = process.env,
): Promise<AgentsServiceJsonResult<AgentsControlPlaneResourceResult>> =>
  fetchControlPlaneResourceFromAgentsService({ kind: 'Budget', ...input }, env)

export const fetchSecretBindingResourceFromAgentsService = async (
  input: AgentsNamedControlPlaneResourceInput,
  env: EnvSource = process.env,
): Promise<AgentsServiceJsonResult<AgentsControlPlaneResourceResult>> =>
  fetchControlPlaneResourceFromAgentsService({ kind: 'SecretBinding', ...input }, env)
