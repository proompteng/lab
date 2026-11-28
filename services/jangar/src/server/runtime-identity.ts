export type JangarRuntimeServiceName = 'jangar'

export const resolveRuntimeServiceName = (_env: NodeJS.ProcessEnv = process.env): JangarRuntimeServiceName => 'jangar'
