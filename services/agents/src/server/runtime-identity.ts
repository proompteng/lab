export type AgentsRuntimeServiceName = 'agents'

export const isAgentsRuntimeService = (_env: NodeJS.ProcessEnv = process.env) => true

export const resolveRuntimeServiceName = (_env: NodeJS.ProcessEnv = process.env): AgentsRuntimeServiceName => 'agents'
