export type JangarRuntimeServiceName = 'jangar'

export const isAgentsRuntimeService = (_env: NodeJS.ProcessEnv = process.env) => false

export const resolveRuntimeServiceName = (_env: NodeJS.ProcessEnv = process.env): JangarRuntimeServiceName => 'jangar'
