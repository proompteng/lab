import { createHash } from 'node:crypto'

import { ATLAS_ELIGIBILITY_VERSION, isAtlasGitFileEligible } from './file-eligibility'

export type AtlasGitFile = {
  mode: string
  objectId: string
  byteSize: number
  path: string
}

export type AtlasGitManifest = {
  eligibilityVersion: string
  files: AtlasGitFile[]
  skipped: number
  treeHash: string
}

export type AtlasCurrentFile = {
  path: string
  contentHash: string
  gitObjectId: string | null
}

const GIT_TREE_ENTRY = /^(\d{6})\s+(\w+)\s+([0-9a-f]+)\s+(\d+|-)\t([\s\S]+)$/i

export const buildAtlasReconciliationWorkflowId = (repository: string) => {
  const normalized = repository.trim().toLowerCase()
  if (!normalized.includes('/')) throw new Error('Atlas repository must be an owner/name slug')
  const readable = normalized.replace(/[^a-z0-9_.-]+/g, '-').slice(0, 120)
  const digest = createHash('sha256').update(normalized).digest('hex').slice(0, 12)
  return `bumba-atlas-reconcile-${readable}-${digest}`
}

export const computeAtlasTreeHash = (files: AtlasGitFile[]) => {
  const hash = createHash('sha256')
  for (const file of files) {
    hash.update(file.path)
    hash.update('\0')
    hash.update(file.objectId)
    hash.update('\0')
  }
  return hash.digest('hex')
}

export const parseAtlasGitTree = (
  raw: string,
  env: Record<string, string | undefined> = process.env,
): AtlasGitManifest => {
  const files: AtlasGitFile[] = []
  let skipped = 0

  for (const entry of raw.split('\0')) {
    if (!entry) continue
    const match = entry.match(GIT_TREE_ENTRY)
    if (!match) {
      skipped += 1
      continue
    }

    const [, mode = '', type = '', objectId = '', rawSize = '', path = ''] = match
    const byteSize = rawSize === '-' ? Number.NaN : Number.parseInt(rawSize, 10)
    const file = { mode, objectId, byteSize, path }
    if (type !== 'blob' || !isAtlasGitFileEligible(file, env)) {
      skipped += 1
      continue
    }
    files.push(file)
  }

  files.sort((left, right) => left.path.localeCompare(right.path))
  return {
    eligibilityVersion: ATLAS_ELIGIBILITY_VERSION,
    files,
    skipped,
    treeHash: computeAtlasTreeHash(files),
  }
}

export const planAtlasFileChanges = (manifest: AtlasGitManifest, currentFiles: AtlasCurrentFile[]) => {
  const currentByPath = new Map(currentFiles.map((file) => [file.path, file]))
  const manifestPaths = new Set(manifest.files.map((file) => file.path))
  const changed = manifest.files.filter((file) => currentByPath.get(file.path)?.gitObjectId !== file.objectId)
  const unchanged = manifest.files.filter((file) => currentByPath.get(file.path)?.gitObjectId === file.objectId)
  const deleted = currentFiles.filter((file) => !manifestPaths.has(file.path))
  return { changed, unchanged, deleted }
}
