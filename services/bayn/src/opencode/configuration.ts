import { canonicalHashV1Result } from '../hash'

export const openCodeVersion = '2.1.3'
export const openCodeDirectory = '/var/lib/bayn-opencode'
export const openCodeModel = 'glm-5.3-flash-free'
export const openCodeRelayOrigin = 'http://127.0.0.1:4098'
export const openCodeNativeOrigin = 'http://127.0.0.1:4097'
export const maximumOpenCodeInputBytes = 32768
export const makeOpenCodeConfiguration = (directory = openCodeDirectory, relayOrigin = openCodeRelayOrigin) => ({
  model: `opencode/${openCodeModel}`,
  default_agent: 'build',
  update: 'disable',
  share: 'disabled',
  snapshots: false,
  lsp: false,
  formatter: false,
  compaction: { auto: false },
  websearch: false,
  warming: false,
  policies: [
    { action: 'provider.use', resource: '*', effect: 'deny' },
    { action: 'provider.use', resource: 'opencode', effect: 'allow' },
    { action: 'tool.use', resource: '*', effect: 'deny' },
    { action: 'integration.use', resource: '*', effect: 'deny' },
    { action: 'tool.use', resource: `read:${directory}/workspace/**`, effect: 'allow' },
  ],
  agents: {
    build: {
      steps: 2,
      permissions: [
        { action: '*', resource: '*', effect: 'deny' },
        { action: 'read', resource: `${directory}/workspace/**`, effect: 'allow' },
      ],
    },
    title: { disabled: true },
    summary: { disabled: true },
    compaction: { disabled: true },
    plan: { disabled: true },
    general: { disabled: true },
    explore: { disabled: true },
  },
  providers: {
    opencode: {
      settings: { baseURL: `${relayOrigin}/provider/v1`, timeout: 120000 },
      body: {
        temperature: 0.6,
        tool_choice: 'none',
        reasoning_effort: 'low',
        response_format: {
          type: 'json_schema',
          json_schema: {
            name: 'bayn_jev_instructions',
            strict: true,
            schema: {
              type: 'object',
              properties: { entry: { type: 'string' } },
              required: ['entry'],
              additionalProperties: false,
            },
          },
        },
      },
      models: {
        [openCodeModel]: { limit: { context: 32768, output: 4096 } },
      },
    },
  },
})
export const openCodeConfiguration = makeOpenCodeConfiguration()
export const openCodeConfigurationHash = canonicalHashV1Result(openCodeConfiguration)
