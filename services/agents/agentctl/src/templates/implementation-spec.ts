import YAML from 'yaml'

export type ImplementationSource = {
  provider: string
  externalId?: string
  url?: string
}

export type ImplementationSpecParams = {
  name?: string
  generateName?: string
  namespace?: string
  summary: string
  text: string
  acceptanceCriteria?: string[]
  labels?: string[]
  source?: ImplementationSource
}

export const buildImplementationSpecYaml = (params: ImplementationSpecParams) => {
  const metadata: Record<string, unknown> = {}
  if (params.name) {
    metadata.name = params.name
  } else if (params.generateName) {
    metadata.generateName = params.generateName
  }
  if (params.namespace) {
    metadata.namespace = params.namespace
  }

  const spec: Record<string, unknown> = {
    summary: params.summary,
    text: params.text,
  }

  if (params.acceptanceCriteria && params.acceptanceCriteria.length > 0) {
    spec.acceptanceCriteria = params.acceptanceCriteria
  }
  if (params.labels && params.labels.length > 0) {
    spec.labels = params.labels
  }
  if (params.source) {
    spec.source = {
      provider: params.source.provider,
      ...(params.source.externalId ? { externalId: params.source.externalId } : {}),
      ...(params.source.url ? { url: params.source.url } : {}),
    }
  }

  const manifest = {
    apiVersion: 'agents.proompteng.ai/v1alpha1',
    kind: 'ImplementationSpec',
    metadata,
    spec,
  }

  return YAML.stringify(manifest)
}
