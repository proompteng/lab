/** Last retained PAPER policy before the acceptance contract froze. Packaging may be rebuilt; policy may not. */
export const frozenDeployedControlIdentity = {
  strategyHash: '3da39b009a0cb2052b007ae9ba51f448c16b69281a37cf5ffe122314f1d801af',
  parametersHash: 'cd004b8b43e50dde70ba70fb43deff19c5c65d60f4455e84a2e8df9991c0335f',
  protocolHash: 'f38c7d47dc0b8eedb13da1ae7e29faa3da2ce8983fee05f4a2c89dc0ec59eb97',
} as const

export const frozenControlOrigin = {
  sourceRevision: 'ef6a069fc121cbe54d148027fe091e3e7f58da9b',
  serviceTree: '8e6336d3898780a7ae14d2de5b176fefa1767183',
  strategyName: 'intraday-momentum',
  parameterSchemaVersion: 'bayn.intraday-momentum.protocol.v3',
  executionModelHash: 'b7fed391f5dc25a41a257de470c96c337715477f1032c1d5d802020b35144b68',
} as const

export const frozenControlPrompts = {
  schemaVersion: 'bayn.frozen-deployed-prompts.v1',
  providers: [],
} as const

export const frozenControlContinuation = {
  schemaVersion: 'bayn.frozen-deployed-continuation.v1',
  origin: frozenControlOrigin,
  strategy: frozenDeployedControlIdentity,
  lifecycle: 'SINGLE_POSITION_CLOSE_OF_SESSION',
} as const
