import { isCodePath } from './code-editor-model'

export const CODE_DRAFT_SCHEMA_VERSION = 1 as const
export const CODE_DRAFT_STORAGE_PREFIX = `tengri:code-draft:v${CODE_DRAFT_SCHEMA_VERSION}:`
export const MAX_CODE_DRAFT_CONTENT_BYTES = 4 * 1024 * 1024
export const MAX_CODE_DRAFT_ENTRIES = 32
export const MAX_CODE_DRAFT_STORAGE_BYTES = 8 * 1024 * 1024
export const MAX_CODE_DRAFT_MEMORY_ENTRIES = 64

const CODE_REVISION_PATTERN = /^[0-9a-f]{64}$/
const MAX_IDENTITY_FIELD_LENGTH = 512
const MAX_CONTENT_TYPE_LENGTH = 256

export type CodeRevision = string
export type CodeBaseRevision = CodeRevision

export type CodeDraftIdentity = {
  ownerId: string
  agentId: string
  agentCreatedAt: string
  path: string
}

export type CodeDraft = CodeDraftIdentity & {
  draftId: string
  schemaVersion: typeof CODE_DRAFT_SCHEMA_VERSION
  content: string
  contentType: string
  baseRevision: CodeBaseRevision
  updatedAt: number
}

export type CodeDraftReadResult =
  | { kind: 'missing' }
  | { kind: 'found'; draft: CodeDraft }
  | { kind: 'unavailable'; message: string }

export type CodeDraftWriteResult =
  | { kind: 'stored' }
  | { kind: 'rejected'; message: string }
  | { kind: 'unavailable'; message: string }

export type CodeDraftRemoveResult = { kind: 'removed' } | { kind: 'missing' } | { kind: 'unavailable'; message: string }

export type CodeDraftStore = {
  read: (identity: CodeDraftIdentity) => CodeDraftReadResult
  write: (draft: CodeDraft) => CodeDraftWriteResult
  remove: (identity: CodeDraftIdentity, draftId?: string) => CodeDraftRemoveResult
}

const inMemoryDrafts = new Map<string, CodeDraft>()
const volatileCodeDrafts = new Map<string, CodeDraft>()
const volatileDraftListeners = new Set<() => void>()
let volatileDraftSnapshot: readonly CodeDraft[] = []
let volatileUnloadGuardInstalled = false

export function parseCodeRevision(value: unknown): CodeBaseRevision | null {
  if (value === 'missing') return value
  if (typeof value !== 'string' || !CODE_REVISION_PATTERN.test(value)) return null
  return value
}

export function isCodeRevision(value: unknown): value is CodeRevision {
  return parseCodeRevision(value) !== null && value !== 'missing'
}

export function codeDraftStorageKey(identity: CodeDraftIdentity): string {
  return codeDraftStorageKeyForId(identity, '')
}

export function codeDraftStorageKeyForId(identity: CodeDraftIdentity, draftId: string): string {
  return [identity.ownerId, identity.agentId, identity.agentCreatedAt, identity.path]
    .map((value) => encodeURIComponent(value))
    .concat(draftId ? encodeURIComponent(draftId) : [])
    .join(':')
    .replace(/^/, CODE_DRAFT_STORAGE_PREFIX)
}

export function createCodeDraft(
  identity: CodeDraftIdentity,
  content: string,
  baseRevision: CodeBaseRevision,
  contentType: string,
  updatedAt = Date.now(),
  draftId = newDraftId(),
): CodeDraft {
  return {
    ...identity,
    baseRevision,
    content,
    contentType,
    draftId,
    schemaVersion: CODE_DRAFT_SCHEMA_VERSION,
    updatedAt,
  }
}

export function rememberCodeDraft(draft: CodeDraft): boolean {
  if (validateVolatileCodeDraft(draft) !== null) return false
  const key = codeDraftStorageKeyForId(draft, draft.draftId)
  if (!inMemoryDrafts.has(key) && inMemoryDrafts.size >= MAX_CODE_DRAFT_MEMORY_ENTRIES) return false
  inMemoryDrafts.set(key, draft)
  return true
}

export function rememberedCodeDraft(identity: CodeDraftIdentity): CodeDraft | undefined {
  return [...inMemoryDrafts.values(), ...volatileCodeDrafts.values()]
    .filter((draft) => sameIdentity(draft, identity))
    .sort((left, right) => right.updatedAt - left.updatedAt)[0]
}

export function forgetCodeDraft(identity: CodeDraftIdentity, draftId?: string): void {
  let changed = false
  for (const draft of inMemoryDrafts.values()) {
    if (!sameIdentity(draft, identity) || (draftId !== undefined && draft.draftId !== draftId)) continue
    inMemoryDrafts.delete(codeDraftStorageKeyForId(draft, draft.draftId))
  }
  for (const draft of volatileCodeDrafts.values()) {
    if (!sameIdentity(draft, identity) || (draftId !== undefined && draft.draftId !== draftId)) continue
    volatileCodeDrafts.delete(codeDraftStorageKeyForId(draft, draft.draftId))
    changed = true
  }
  if (changed) publishVolatileDrafts()
}

export function markCodeDraftVolatile(draft: CodeDraft): boolean {
  if (validateVolatileCodeDraft(draft) !== null) return false
  const key = codeDraftStorageKeyForId(draft, draft.draftId)
  // The editor already owns this allocated content. Never evict a volatile draft
  // after a durable write is rejected; it must remain available for export until
  // the user saves, discards, or downloads it.
  volatileCodeDrafts.set(key, draft)
  publishVolatileDrafts()
  return true
}

export function markCodeDraftDurable(draft: CodeDraft): void {
  const key = codeDraftStorageKeyForId(draft, draft.draftId)
  if (!volatileCodeDrafts.delete(key)) return
  publishVolatileDrafts()
}

export function getVolatileCodeDrafts(): readonly CodeDraft[] {
  return volatileDraftSnapshot
}

export function subscribeVolatileCodeDrafts(listener: () => void): () => void {
  volatileDraftListeners.add(listener)
  return () => volatileDraftListeners.delete(listener)
}

function publishVolatileDrafts(): void {
  volatileDraftSnapshot = [...volatileCodeDrafts.values()].sort((left, right) => right.updatedAt - left.updatedAt)
  if (typeof window !== 'undefined') {
    if (volatileCodeDrafts.size > 0 && !volatileUnloadGuardInstalled) {
      window.addEventListener('beforeunload', handleVolatileDraftBeforeUnload)
      volatileUnloadGuardInstalled = true
    } else if (volatileCodeDrafts.size === 0 && volatileUnloadGuardInstalled) {
      window.removeEventListener('beforeunload', handleVolatileDraftBeforeUnload)
      volatileUnloadGuardInstalled = false
    }
  }
  for (const listener of volatileDraftListeners) listener()
}

function handleVolatileDraftBeforeUnload(event: BeforeUnloadEvent): void {
  if (volatileCodeDrafts.size === 0) return
  event.preventDefault()
  event.returnValue = ''
}

export function mergeCodeDraftContent(serverContent: string, draftContent: string): string {
  return `<<<<<<< server\n${serverContent}\n=======\n${draftContent}\n>>>>>>> local draft`
}

export function createBrowserCodeDraftStore(): CodeDraftStore {
  let storage: Storage | null = null
  try {
    storage = globalThis.localStorage
  } catch {
    storage = null
  }
  return createCodeDraftStore(storage)
}

export function createCodeDraftStore(storage: Storage | null): CodeDraftStore {
  const read = (identity: CodeDraftIdentity): CodeDraftReadResult => {
    if (!isCodeDraftIdentity(identity)) return { kind: 'missing' }
    if (!storage) return storageUnavailable('read')
    const entries = collectEntries(storage)
    if (entries.kind === 'unavailable') return entries
    const draft = entries.drafts
      .filter((candidate) => sameIdentity(candidate, identity))
      .sort((left, right) => right.updatedAt - left.updatedAt)[0]
    return draft ? { kind: 'found', draft } : { kind: 'missing' }
  }

  const write = (draft: CodeDraft): CodeDraftWriteResult => {
    const validation = validateCodeDraft(draft)
    if (validation) return { kind: 'rejected', message: validation }
    if (!storage) return storageUnavailable('save')

    const key = codeDraftStorageKeyForId(draft, draft.draftId)
    let serialized: string
    try {
      serialized = JSON.stringify(draft)
    } catch {
      return { kind: 'rejected', message: 'The edited draft could not be serialized for recovery.' }
    }
    const serializedBytes = byteLength(serialized)
    if (serializedBytes > MAX_CODE_DRAFT_STORAGE_BYTES) {
      return { kind: 'rejected', message: 'The edited draft is too large to keep for recovery.' }
    }

    const entries = collectEntries(storage)
    if (entries.kind === 'unavailable') return entries
    try {
      const existing = entries.drafts.filter((entry) => codeDraftStorageKeyForId(entry, entry.draftId) !== key)
      const remaining = [...existing]
      const totalBytes =
        serializedBytes + remaining.reduce((total, entry) => total + byteLength(JSON.stringify(entry)), 0)
      if (remaining.length + 1 > MAX_CODE_DRAFT_ENTRIES || totalBytes > MAX_CODE_DRAFT_STORAGE_BYTES) {
        return {
          kind: 'rejected',
          message: 'Code recovery storage is full. Download this draft before closing the editor.',
        }
      }
      storage.setItem(key, serialized)
      return { kind: 'stored' }
    } catch {
      return storageUnavailable('save')
    }
  }

  const remove = (identity: CodeDraftIdentity, draftId?: string): CodeDraftRemoveResult => {
    if (!isCodeDraftIdentity(identity)) return { kind: 'missing' }
    if (!storage) return storageUnavailable('remove')
    try {
      const entries = collectEntries(storage)
      if (entries.kind === 'unavailable') return entries
      const matches = entries.drafts.filter(
        (draft) => sameIdentity(draft, identity) && (draftId === undefined || draft.draftId === draftId),
      )
      if (!matches.length) return { kind: 'missing' }
      for (const draft of matches) storage.removeItem(codeDraftStorageKeyForId(draft, draft.draftId))
      return { kind: 'removed' }
    } catch {
      return storageUnavailable('remove')
    }
  }

  return { read, remove, write }
}

function isCodeDraftIdentity(value: unknown): value is CodeDraftIdentity {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const identity = value as Record<string, unknown>
  return (
    isBoundedIdentityPart(identity.ownerId) &&
    isBoundedIdentityPart(identity.agentId) &&
    isBoundedIdentityPart(identity.agentCreatedAt) &&
    typeof identity.path === 'string' &&
    isCodePath(identity.path)
  )
}

function sameIdentity(left: CodeDraftIdentity, right: CodeDraftIdentity): boolean {
  return (
    left.ownerId === right.ownerId &&
    left.agentId === right.agentId &&
    left.agentCreatedAt === right.agentCreatedAt &&
    left.path === right.path
  )
}

function isBoundedIdentityPart(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= MAX_IDENTITY_FIELD_LENGTH
}

function validateCodeDraft(value: CodeDraft): string | null {
  const metadataError = validateDraftMetadata(value)
  if (metadataError) return metadataError
  if (typeof value.content !== 'string' || byteLength(value.content) > MAX_CODE_DRAFT_CONTENT_BYTES) {
    return 'The edited draft is too large to keep for recovery.'
  }
  return null
}

function validateVolatileCodeDraft(value: CodeDraft): string | null {
  const metadataError = validateDraftMetadata(value)
  if (metadataError) return metadataError
  if (typeof value.content !== 'string') {
    return 'The edited draft has invalid content for recovery.'
  }
  return null
}

function validateDraftMetadata(value: CodeDraft): string | null {
  if (value.schemaVersion !== CODE_DRAFT_SCHEMA_VERSION || !isCodeDraftIdentity(value)) {
    return 'The edited draft has an invalid recovery identity.'
  }
  if (typeof value.contentType !== 'string' || value.contentType.length > MAX_CONTENT_TYPE_LENGTH) {
    return 'The edited draft has an invalid content type.'
  }
  if (!isBoundedIdentityPart(value.draftId)) return 'The edited draft has an invalid recovery identity.'
  if (parseCodeRevision(value.baseRevision) === null) return 'The edited draft has an invalid base revision.'
  if (!Number.isSafeInteger(value.updatedAt) || value.updatedAt <= 0) {
    return 'The edited draft has an invalid recovery timestamp.'
  }
  return null
}

function parseCodeDraft(value: unknown): CodeDraft | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null
  const schemaVersion = Reflect.get(value, 'schemaVersion')
  const ownerId = Reflect.get(value, 'ownerId')
  const agentId = Reflect.get(value, 'agentId')
  const agentCreatedAt = Reflect.get(value, 'agentCreatedAt')
  const path = Reflect.get(value, 'path')
  const content = Reflect.get(value, 'content')
  const contentType = Reflect.get(value, 'contentType')
  const draftId = Reflect.get(value, 'draftId')
  const baseRevision = parseCodeRevision(Reflect.get(value, 'baseRevision'))
  const updatedAt = Reflect.get(value, 'updatedAt')
  if (
    schemaVersion !== CODE_DRAFT_SCHEMA_VERSION ||
    typeof ownerId !== 'string' ||
    typeof agentId !== 'string' ||
    typeof agentCreatedAt !== 'string' ||
    typeof path !== 'string' ||
    typeof content !== 'string' ||
    typeof contentType !== 'string' ||
    typeof draftId !== 'string' ||
    baseRevision === null ||
    typeof updatedAt !== 'number'
  ) {
    return null
  }
  const draft = {
    agentCreatedAt,
    agentId,
    baseRevision,
    content,
    contentType,
    draftId,
    ownerId,
    path,
    schemaVersion,
    updatedAt,
  }
  return validateCodeDraft(draft) === null ? draft : null
}

function collectEntries(
  storage: Storage,
): { kind: 'ok'; drafts: CodeDraft[]; invalidKeys: string[] } | { kind: 'unavailable'; message: string } {
  const drafts: CodeDraft[] = []
  const invalidKeys: string[] = []
  try {
    for (let index = 0; index < storage.length; index += 1) {
      const key = storage.key(index)
      if (!key || !key.startsWith(CODE_DRAFT_STORAGE_PREFIX)) continue
      const serialized = storage.getItem(key)
      if (serialized === null) continue
      let parsed: unknown
      try {
        parsed = JSON.parse(serialized)
      } catch {
        invalidKeys.push(key)
        continue
      }
      const draft = parseCodeDraft(parsed)
      if (draft) drafts.push(draft)
      else invalidKeys.push(key)
    }
    drafts.sort((left, right) => left.updatedAt - right.updatedAt)
    return { kind: 'ok', drafts, invalidKeys }
  } catch {
    return storageUnavailable('inspect')
  }
}

function byteLength(value: string): number {
  try {
    return new TextEncoder().encode(value).byteLength
  } catch {
    return value.length
  }
}

function newDraftId(): string {
  try {
    return crypto.randomUUID()
  } catch {
    return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`
  }
}

function storageUnavailable(operation: string): { kind: 'unavailable'; message: string } {
  return {
    kind: 'unavailable',
    message: `Browser storage is unavailable, so Code could not ${operation === 'save' ? 'save this draft for recovery' : `${operation} the recovery draft`}. Keep this tab open while storage is unavailable.`,
  }
}
