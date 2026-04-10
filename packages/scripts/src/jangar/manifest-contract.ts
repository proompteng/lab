import { readFileSync, writeFileSync } from 'node:fs'

import YAML from 'yaml'

type AnyRecord = Record<string, unknown>

const asRecord = (value: unknown): AnyRecord | null => {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    return value as AnyRecord
  }
  return null
}

const asString = (value: unknown) => (typeof value === 'string' && value.trim() ? value.trim() : null)

const parseYamlRecord = (source: string): AnyRecord => asRecord(YAML.parse(source)) ?? {}

const stringifyYamlRecord = (document: AnyRecord) => YAML.stringify(document, { lineWidth: 120 })

const readImageEntries = (document: AnyRecord) => (Array.isArray(document.images) ? document.images : [])

const findImageEntry = (document: AnyRecord, imageName: string) =>
  readImageEntries(document).find((entry) => asString(asRecord(entry)?.name) === imageName)

const normalizeDigest = (value: string) => {
  const trimmed = value.trim()
  if (!trimmed) return trimmed
  return trimmed.includes('@') ? trimmed.slice(trimmed.lastIndexOf('@') + 1) : trimmed
}

export const extractImageDigestFromKustomizationSource = (source: string, imageName: string): string => {
  const document = parseYamlRecord(source)
  const imageEntry = asRecord(findImageEntry(document, imageName))
  const digest = asString(imageEntry?.digest)

  if (!digest) {
    throw new Error(`Unable to find digest for image '${imageName}' in kustomization`)
  }

  return normalizeDigest(digest)
}

export const updateKustomizationImage = (path: string, imageName: string, tag: string, digest: string): boolean => {
  const source = readFileSync(path, 'utf8')
  const document = parseYamlRecord(source)
  const images = readImageEntries(document)
  let imageEntry = asRecord(findImageEntry(document, imageName))

  if (!imageEntry) {
    imageEntry = {}
    images.push(imageEntry)
    document.images = images
  }

  imageEntry.name = imageName
  imageEntry.newTag = tag
  imageEntry.digest = normalizeDigest(digest)

  const updated = stringifyYamlRecord(document)
  if (source === updated) {
    return false
  }

  writeFileSync(path, updated, 'utf8')
  return true
}

export const updateManifestAnnotation = (path: string, annotationKey: string, value: string): boolean => {
  const source = readFileSync(path, 'utf8')
  const document = parseYamlRecord(source)
  const metadata = asRecord(document.metadata) ?? {}
  const annotations = asRecord(metadata.annotations) ?? {}

  annotations[annotationKey] = value
  metadata.annotations = annotations
  document.metadata = metadata

  const updated = stringifyYamlRecord(document)
  if (source === updated) {
    return false
  }

  writeFileSync(path, updated, 'utf8')
  return true
}
