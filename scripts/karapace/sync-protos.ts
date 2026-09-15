#!/usr/bin/env bun

/**
 * Synchronise repository protobuf schemas with a Karapace / Schema Registry instance.
 *
 * The manifest (default: proto/schema-subjects.json) lists each source file and the
 * registry subjects that should receive it. Use --dry-run (default for PR builds)
 * to preview registrations without touching the registry.
 */

import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { parseArgs } from 'node:util'

type Reference = {
  name: string
  subject: string
  version?: number
}

type SubjectEntry = {
  name: string
  references?: Reference[]
}

type ManifestEntry = {
  file?: string
  module?: string
  path?: string
  subjects: SubjectEntry[]
  references?: Reference[]
  order?: number
}

type Manifest = {
  schemas: ManifestEntry[]
}

const { values } = parseArgs({
  options: {
    manifest: {
      type: 'string',
      default: 'proto/schema-subjects.json',
    },
    'proto-root': {
      type: 'string',
      default: 'proto',
    },
    'karapace-url': {
      type: 'string',
      default: process.env.KARAPACE_URL ?? '',
    },
    username: {
      type: 'string',
      default: process.env.KARAPACE_USER ?? '',
    },
    password: {
      type: 'string',
      default: process.env.KARAPACE_PASSWORD ?? '',
    },
    'dry-run': {
      type: 'boolean',
      default: false,
    },
  },
})

const manifestPath = resolve(values.manifest)
const protoRoot = resolve(values['proto-root'])
const baseUrl = values['karapace-url']
const username = values.username
const password = values.password
const dryRun = values['dry-run']

if (!baseUrl && !dryRun) {
  console.error('KARAPACE_URL must be provided via flag or environment')
  process.exit(1)
}

const manifest: Manifest = JSON.parse(await readFile(manifestPath, 'utf8'))

if (!Array.isArray(manifest.schemas)) {
  console.error(`Manifest ${manifestPath} missing 'schemas' array`)
  process.exit(1)
}

const sortedEntries = [...manifest.schemas].sort((a, b) => {
  const orderA = (a as { order?: number }).order ?? 0
  const orderB = (b as { order?: number }).order ?? 0
  if (orderA !== orderB) {
    return orderA - orderB
  }
  const fileA = a.file ?? `${a.module ?? ''}:${a.path ?? ''}`
  const fileB = b.file ?? `${b.module ?? ''}:${b.path ?? ''}`
  return fileA.localeCompare(fileB)
})

const authHeader =
  username && password ? `Basic ${Buffer.from(`${username}:${password}`).toString('base64')}` : undefined

async function readModuleFile(moduleName: string, modulePath: string): Promise<string> {
  const workDir = await mkdtemp(join(tmpdir(), 'karapace-'))
  const result = Bun.spawnSync({
    cmd: ['buf', 'export', moduleName, '--path', modulePath, '--output', workDir],
  })
  if (!result.success) {
    await rm(workDir, { recursive: true, force: true })
    const stderr = new TextDecoder().decode(result.stderr)
    throw new Error(`Failed to export ${moduleName}/${modulePath}: ${stderr}`)
  }
  const absolutePath = join(workDir, modulePath)
  const contents = await readFile(absolutePath, 'utf8')
  await rm(workDir, { recursive: true, force: true })
  return contents
}

async function loadSchemaSource(entry: ManifestEntry): Promise<string> {
  if (entry.file) {
    return readFile(join(protoRoot, entry.file), 'utf8')
  }
  if (entry.module && entry.path) {
    return readModuleFile(entry.module, entry.path)
  }
  throw new Error('Manifest entry must include `file` or (`module` and `path`).')
}

const referenceCache = new Map<string, number>()

async function resolveReferences(refs: Reference[] | undefined): Promise<Reference[] | undefined> {
  if (!refs || refs.length === 0) {
    return refs
  }

  if (dryRun || !baseUrl) {
    return refs.map((ref) => ({ ...ref }))
  }

  const resolved: Reference[] = []
  for (const ref of refs) {
    if (ref.version !== undefined) {
      resolved.push(ref)
      continue
    }

    if (referenceCache.has(ref.subject)) {
      resolved.push({ ...ref, version: referenceCache.get(ref.subject) as string })
      continue
    }

    const response = await fetch(`${baseUrl}/subjects/${encodeURIComponent(ref.subject)}/versions/latest`, {
      method: 'GET',
      headers: authHeader ? { Authorization: authHeader } : undefined,
    })

    if (!response.ok) {
      const body = await response.text()
      throw new Error(`Failed to resolve latest version for ${ref.subject}: ${response.status} ${body}`)
    }

    const json = (await response.json()) as { version: number }
    referenceCache.set(ref.subject, json.version)
    resolved.push({ ...ref, version: json.version })
  }

  return resolved
}

async function register(subject: string, schemaSource: string, references: Reference[] | undefined): Promise<void> {
  if (dryRun || !baseUrl) {
    console.log(`[dry-run] would register ${subject} (${schemaSource.length} bytes)`)
    return
  }

  const payload: Record<string, unknown> = {
    schemaType: 'PROTOBUF',
    schema: schemaSource,
  }

  if (Array.isArray(references) && references.length > 0) {
    payload.references = references
  }

  const response = await fetch(`${baseUrl}/subjects/${encodeURIComponent(subject)}/versions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/vnd.schemaregistry.v1+json',
      ...(authHeader ? { Authorization: authHeader } : {}),
    },
    body: JSON.stringify(payload),
  })

  if (!response.ok) {
    const body = await response.text()
    throw new Error(`Failed to register ${subject}: ${response.status} ${body}`)
  }

  const json = (await response.json()) as { id?: number; version?: number }
  console.log(`Registered ${subject} (id=${json.id ?? '?'}, version=${json.version ?? '?'})`)
}

for (const entry of sortedEntries) {
  if (!Array.isArray(entry.subjects) || entry.subjects.length === 0) {
    console.warn(`Skipping invalid manifest entry: ${JSON.stringify(entry)}`)
    continue
  }

  const schemaText = await loadSchemaSource(entry)
  const baseReferences = entry.references ?? []

  for (const subject of entry.subjects) {
    const refs = subject.references ?? baseReferences
    const resolvedRefs = await resolveReferences(refs)
    await register(subject.name, schemaText, resolvedRefs)
  }
}
