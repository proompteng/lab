import { createHash } from 'node:crypto'

const sourceRevisionPattern = /^[0-9a-f]{40}$/
const blobOidPattern = /^[0-9a-f]{40}$/
const sha256Pattern = /^[0-9a-f]{64}$/

export const candidateDevelopmentLocalReceiptSchemaVersion = 'bayn.candidate-development-local-attempt.v1' as const

export type CandidateDevelopmentLocalReceiptStatus = 'reserved' | 'completed' | 'failed'

export interface CandidateDevelopmentLocalArguments {
  readonly modulePath: string
  readonly sourceManifestPath: string
  readonly runtimeMarketDataPath: string
}

export interface CandidateDevelopmentLocalSourceBindingInput {
  readonly sourceRevision: string
  readonly modulePath: string
  readonly moduleBlobOid: string
  readonly moduleSha256: string
  readonly sourceManifestPath: string
  readonly sourceManifestBlobOid: string
  readonly sourceManifestSha256: string
}

export interface CandidateDevelopmentLocalSourceBinding extends CandidateDevelopmentLocalSourceBindingInput {
  readonly bindingHash: string
}

export interface CandidateDevelopmentLocalAttemptReceipt {
  readonly schemaVersion: typeof candidateDevelopmentLocalReceiptSchemaVersion
  readonly attempt: 1
  readonly status: CandidateDevelopmentLocalReceiptStatus
  readonly source: CandidateDevelopmentLocalSourceBinding
  readonly exitCode?: number
}

export type CandidateDevelopmentLocalValidation<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly code: 'invalid-arguments' | 'source-binding-invalid'; readonly message: string }

const success = <T>(value: T): CandidateDevelopmentLocalValidation<T> => ({ ok: true, value })

const failure = (
  code: 'invalid-arguments' | 'source-binding-invalid',
  message: string,
): CandidateDevelopmentLocalValidation<never> => ({ ok: false, code, message })

const pathArgument = (value: unknown): string | undefined => {
  if (typeof value !== 'string' || value.length === 0 || value.includes('\u0000')) return undefined
  if (value.includes('\n') || value.includes('\r')) return undefined
  return value
}

const repositoryPath = (value: unknown): string | undefined => {
  const path = pathArgument(value)
  if (path === undefined || path.startsWith('/') || path.split('/').some((part) => part === '..' || part === '')) {
    return undefined
  }
  return path
}

const hash = (value: unknown, pattern: RegExp): string | undefined => {
  if (typeof value !== 'string' || !pattern.test(value)) return undefined
  return value
}

export const parseCandidateDevelopmentLocalArguments = (
  argv: readonly string[],
): CandidateDevelopmentLocalValidation<CandidateDevelopmentLocalArguments> => {
  if (argv.length !== 3) {
    return failure('invalid-arguments', 'expected exactly <module> <source-manifest> <typed-runtime-market-data.json>')
  }
  const [modulePath, sourceManifestPath, runtimeMarketDataPath] = argv
  if (
    pathArgument(modulePath) === undefined ||
    pathArgument(sourceManifestPath) === undefined ||
    pathArgument(runtimeMarketDataPath) === undefined
  ) {
    return failure('invalid-arguments', 'module, source manifest, and runtime market-data paths must be valid paths')
  }
  return success({ modulePath, sourceManifestPath, runtimeMarketDataPath })
}

const sourceBindingCanonicalBytes = (binding: CandidateDevelopmentLocalSourceBindingInput): string =>
  JSON.stringify([
    'bayn.candidate-development-local-source-binding.v1',
    binding.sourceRevision,
    binding.modulePath,
    binding.moduleBlobOid,
    binding.moduleSha256,
    binding.sourceManifestPath,
    binding.sourceManifestBlobOid,
    binding.sourceManifestSha256,
  ])

export const validateCandidateDevelopmentLocalSourceBinding = (
  input: CandidateDevelopmentLocalSourceBindingInput,
): CandidateDevelopmentLocalValidation<CandidateDevelopmentLocalSourceBinding> => {
  const sourceRevision = hash(input.sourceRevision, sourceRevisionPattern)
  const modulePath = repositoryPath(input.modulePath)
  const moduleBlobOid = hash(input.moduleBlobOid, blobOidPattern)
  const moduleSha256 = hash(input.moduleSha256, sha256Pattern)
  const sourceManifestPath = repositoryPath(input.sourceManifestPath)
  const sourceManifestBlobOid = hash(input.sourceManifestBlobOid, blobOidPattern)
  const sourceManifestSha256 = hash(input.sourceManifestSha256, sha256Pattern)
  if (
    sourceRevision === undefined ||
    modulePath === undefined ||
    moduleBlobOid === undefined ||
    moduleSha256 === undefined ||
    sourceManifestPath === undefined ||
    sourceManifestBlobOid === undefined ||
    sourceManifestSha256 === undefined
  ) {
    return failure('source-binding-invalid', 'reviewed source binding contains an invalid Git identity or path')
  }
  const binding = {
    sourceRevision,
    modulePath,
    moduleBlobOid,
    moduleSha256,
    sourceManifestPath,
    sourceManifestBlobOid,
    sourceManifestSha256,
  } satisfies CandidateDevelopmentLocalSourceBindingInput
  return success({
    ...binding,
    bindingHash: createHash('sha256').update(sourceBindingCanonicalBytes(binding), 'utf8').digest('hex'),
  })
}

export const makeCandidateDevelopmentLocalAttemptReceipt = (
  source: CandidateDevelopmentLocalSourceBinding,
  status: CandidateDevelopmentLocalReceiptStatus,
  exitCode?: number,
): CandidateDevelopmentLocalAttemptReceipt => ({
  schemaVersion: candidateDevelopmentLocalReceiptSchemaVersion,
  attempt: 1,
  status,
  source,
  ...(exitCode === undefined ? {} : { exitCode }),
})

export const serializeCandidateDevelopmentLocalReceipt = (receipt: CandidateDevelopmentLocalAttemptReceipt): string =>
  `${JSON.stringify(receipt)}\n`
