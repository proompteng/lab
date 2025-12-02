const ownedBy = 'jangar'

export const supportedModels = ['gpt-5.1-codex-max', 'gpt-5.1-codex', 'gpt-5.1-codex-mini', 'gpt-5.1'] as const

const isSupportedModelValue = (model: unknown): model is (typeof supportedModels)[number] =>
  typeof model === 'string' && supportedModels.includes(model as (typeof supportedModels)[number])

const envDefaultModel = Bun.env.CODEX_DEFAULT_MODEL
export const defaultCodexModel = isSupportedModelValue(envDefaultModel) ? envDefaultModel : supportedModels[0]

export const isSupportedModel = (model?: string | null): model is (typeof supportedModels)[number] =>
  isSupportedModelValue(model)

export const resolveModel = (requested?: string | null) => {
  if (!requested || requested === 'meta-orchestrator') {
    return defaultCodexModel
  }
  if (isSupportedModel(requested)) {
    return requested
  }
  return defaultCodexModel
}

export const buildModelsResponse = () => ({
  object: 'list',
  data: supportedModels.map((id) => ({
    id,
    object: 'model' as const,
    owned_by: ownedBy,
    created: Math.floor(Date.now() / 1000),
    permission: [],
    root: id,
    parent: null,
  })),
})
