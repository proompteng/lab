import { asRecord, asString } from '~/server/primitives-http'

export type ImplementationContractMapping = { from: string; to: string }

const DEFAULT_METADATA_MAPPINGS: ImplementationContractMapping[] = [
  { from: 'repo', to: 'repository' },
  { from: 'issueRepository', to: 'repository' },
  { from: 'issue', to: 'issueNumber' },
  { from: 'issueId', to: 'issueNumber' },
  { from: 'issue_id', to: 'issueNumber' },
  { from: 'issue_number', to: 'issueNumber' },
  { from: 'title', to: 'issueTitle' },
  { from: 'body', to: 'issueBody' },
  { from: 'url', to: 'issueUrl' },
  { from: 'baseBranch', to: 'base' },
  { from: 'base_ref', to: 'base' },
  { from: 'baseRef', to: 'base' },
  { from: 'headBranch', to: 'head' },
  { from: 'head_ref', to: 'head' },
  { from: 'headRef', to: 'head' },
  { from: 'workflowStage', to: 'stage' },
  { from: 'codexStage', to: 'stage' },
]

const parseGithubExternalId = (externalId: string) => {
  const trimmed = externalId.trim()
  const [repo, number] = trimmed.split('#')
  if (!repo || !number) return null
  return { repository: repo.trim(), issueNumber: number.trim() }
}

const normalizeContractMappings = (value: unknown): ImplementationContractMapping[] => {
  if (!Array.isArray(value)) return []
  const mappings: ImplementationContractMapping[] = []
  for (const entry of value) {
    const record = asRecord(entry)
    if (!record) continue
    const from = asString(record.from)?.trim()
    const to = asString(record.to)?.trim()
    if (!from || !to) continue
    mappings.push({ from, to })
  }
  return mappings
}

const normalizeRequiredKeys = (value: unknown) => {
  if (!Array.isArray(value)) return []
  const keys = value
    .filter((item): item is string => typeof item === 'string')
    .map((item) => item.trim())
    .filter((item) => item.length > 0)
  return Array.from(new Set(keys))
}

const hasInvalidRequiredKeys = (value: unknown) =>
  Array.isArray(value) && value.some((key) => typeof key !== 'string' || key.trim().length === 0)

const hasInvalidContractMappings = (value: unknown) =>
  Array.isArray(value) &&
  value.some((entry) => {
    const record = asRecord(entry)
    if (!record) return true
    const from = asString(record.from)?.trim()
    const to = asString(record.to)?.trim()
    return !from || !to
  })

const applyMetadataMappings = (metadata: Record<string, string>, mappings: ImplementationContractMapping[]) => {
  for (const mapping of mappings) {
    const fromValue = metadata[mapping.from]
    if (!fromValue || metadata[mapping.to]) continue
    metadata[mapping.to] = fromValue
  }
}

const setMetadataIfMissing = (metadata: Record<string, string>, key: string, value: string) => {
  if (!value || metadata[key]) return
  metadata[key] = value
}

type ResolveParam = (params: Record<string, string>, keys: string[]) => string

export const createImplementationContractTools = (resolveParam: ResolveParam) => {
  const buildEventContext = (
    implementation: Record<string, unknown>,
    parameters: Record<string, string>,
    contractOverride?: { requiredKeys?: string[]; mappings?: ImplementationContractMapping[] },
  ) => {
    const source = asRecord(implementation.source) ?? {}
    const provider = asString(source.provider) ?? ''
    const externalId = asString(source.externalId) ?? ''
    const sourceUrl = asString(source.url) ?? ''

    const contract = asRecord(implementation.contract) ?? {}
    const contractMappings = contractOverride?.mappings ?? normalizeContractMappings(contract.mappings)
    const requiredKeys = contractOverride?.requiredKeys ?? normalizeRequiredKeys(contract.requiredKeys)

    const summary = asString(implementation.summary) ?? ''
    const text = asString(implementation.text) ?? ''

    const metadata: Record<string, string> = {}
    for (const [key, value] of Object.entries(parameters)) {
      if (typeof value !== 'string') continue
      const trimmed = value.trim()
      if (!trimmed) continue
      metadata[key] = trimmed
    }

    applyMetadataMappings(metadata, DEFAULT_METADATA_MAPPINGS)
    applyMetadataMappings(metadata, contractMappings)

    let repository = metadata.repository ?? resolveParam(parameters, ['repository'])
    let issueNumber = metadata.issueNumber ?? resolveParam(parameters, ['issueNumber'])

    const resolvedIssueTitle = metadata.issueTitle ?? resolveParam(parameters, ['issueTitle'])
    const issueTitle = resolvedIssueTitle || summary
    const resolvedIssueBody = metadata.issueBody ?? resolveParam(parameters, ['issueBody'])
    const issueBody = resolvedIssueBody || text
    const resolvedIssueUrl = metadata.issueUrl ?? resolveParam(parameters, ['issueUrl'])
    const issueUrl = resolvedIssueUrl || sourceUrl
    const resolvedPrompt = metadata.prompt ?? resolveParam(parameters, ['prompt'])
    const prompt = resolvedPrompt || text || summary
    const base = metadata.base ?? resolveParam(parameters, ['base'])
    const head = metadata.head ?? resolveParam(parameters, ['head'])
    const stage = metadata.stage ?? resolveParam(parameters, ['stage'])

    if ((!repository || !issueNumber) && provider === 'github' && externalId) {
      const parsed = parseGithubExternalId(externalId)
      if (parsed) {
        repository = repository || parsed.repository
        issueNumber = issueNumber || parsed.issueNumber
      }
    }

    setMetadataIfMissing(metadata, 'repository', repository)
    setMetadataIfMissing(metadata, 'issueNumber', issueNumber)
    setMetadataIfMissing(metadata, 'issueTitle', issueTitle)
    setMetadataIfMissing(metadata, 'issueBody', issueBody)
    setMetadataIfMissing(metadata, 'issueUrl', issueUrl)
    setMetadataIfMissing(metadata, 'url', issueUrl)
    setMetadataIfMissing(metadata, 'base', base)
    setMetadataIfMissing(metadata, 'head', head)
    setMetadataIfMissing(metadata, 'stage', stage)
    setMetadataIfMissing(metadata, 'prompt', prompt)

    const payload: Record<string, unknown> = {}
    if (prompt) payload.prompt = prompt
    if (repository) payload.repository = repository
    if (issueNumber) payload.issueNumber = issueNumber
    if (issueTitle) payload.issueTitle = issueTitle
    if (issueBody) payload.issueBody = issueBody
    if (issueUrl) payload.issueUrl = issueUrl
    if (base) payload.base = base
    if (head) payload.head = head
    if (stage) payload.stage = stage
    if (Object.keys(metadata).length > 0) {
      payload.metadata = { map: metadata }
    }

    const missingRequiredKeys = requiredKeys.filter((key) => !metadata[key])

    return { payload, metadata, missingRequiredKeys, requiredKeys }
  }

  const buildEventPayload = (implementation: Record<string, unknown>, parameters: Record<string, string>) =>
    buildEventContext(implementation, parameters).payload

  const validateImplementationContract = (
    implementation: Record<string, unknown>,
    parameters: Record<string, string>,
  ) => {
    const contract = asRecord(implementation.contract) ?? {}
    if (hasInvalidRequiredKeys(contract.requiredKeys)) {
      return {
        ok: false as const,
        reason: 'InvalidContract',
        requiredKeys: normalizeRequiredKeys(contract.requiredKeys),
        message: 'spec.contract.requiredKeys must be non-empty strings',
      }
    }
    if (hasInvalidContractMappings(contract.mappings)) {
      return {
        ok: false as const,
        reason: 'InvalidContract',
        requiredKeys: normalizeRequiredKeys(contract.requiredKeys),
        message: 'spec.contract.mappings entries must include non-empty from and to',
      }
    }

    const requiredKeys = normalizeRequiredKeys(contract.requiredKeys)
    const { missingRequiredKeys } = buildEventContext(implementation, parameters, {
      requiredKeys,
      mappings: normalizeContractMappings(contract.mappings),
    })
    if (missingRequiredKeys.length === 0) {
      return { ok: true as const, requiredKeys }
    }
    return {
      ok: false as const,
      reason: 'MissingRequiredMetadata',
      requiredKeys,
      missing: missingRequiredKeys,
      message: `missing required metadata keys: ${missingRequiredKeys.join(', ')}`,
    }
  }

  const buildContractStatus = (contractCheck: { ok: boolean; requiredKeys: string[]; missing?: string[] }) => {
    if (contractCheck.requiredKeys.length === 0) return undefined
    const status: Record<string, unknown> = { requiredKeys: contractCheck.requiredKeys }
    if (!contractCheck.ok && contractCheck.missing && contractCheck.missing.length > 0) {
      status.missingKeys = contractCheck.missing
    }
    return status
  }

  return {
    buildEventContext,
    buildEventPayload,
    validateImplementationContract,
    buildContractStatus,
  }
}
