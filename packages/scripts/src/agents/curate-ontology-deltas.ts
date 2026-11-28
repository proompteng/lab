#!/usr/bin/env bun

import { lstat, mkdtemp, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { parseArgs } from 'node:util'

import { fatal } from '../shared/cli'
import { validateAgentsOntologyAnalyses } from './agents-ontology-schema'
import { mergeKnowledgeDeltas, serializeBundle } from './ontology-deltas'
import { containsCredentials, disclosureProblem } from './ontology-disclosure'
import { maxOntologyJsonBytes } from './ontology-json'

const usage =
  'Usage: curate-ontology-deltas --input <file-or-dir> [--input <file-or-dir> ...] --bundle <path> [--mode dry-run|write]'
const safePath = (path: string) => (disclosureProblem(path) ? '<redacted path>' : JSON.stringify(path))

const inputFiles = async (inputs: string[]) => {
  const files = new Set<string>()
  for (const input of inputs) {
    const path = resolve(input)
    const entry = await lstat(path).catch(() => null)
    if (entry?.isFile()) {
      files.add(path)
    } else if (entry?.isDirectory()) {
      const entries = await readdir(path, { withFileTypes: true }).catch(() => {
        throw new Error(`Cannot read directory ${safePath(path)}`)
      })
      const json = entries.filter((file) => file.name.endsWith('.json'))
      if (json.length === 0) throw new Error(`No JSON proposal files in ${safePath(path)}`)
      for (const file of json) files.add(join(path, file.name))
    } else {
      throw new Error(`Expected a regular file or directory at ${safePath(path)}`)
    }
  }
  return [...files].sort()
}

const readJson = async (path: string) => {
  const file = await lstat(path).catch(() => null)
  const label = safePath(path)
  if (!file?.isFile() || file.size > maxOntologyJsonBytes)
    throw new Error(`${label}: expected a regular JSON file up to 1 MiB`)
  const raw = await readFile(path, 'utf8').catch(() => {
    throw new Error(`${label}: could not read file`)
  })
  if (containsCredentials(raw)) throw new Error(`${label}: possible credential; remove it before submitting`)
  try {
    const value: unknown = JSON.parse(raw)
    return { label, raw, value, mode: file.mode & 0o777 }
  } catch {
    throw new Error(`${label}: invalid JSON`)
  }
}

const writeBundle = async (path: string, contents: string, mode: number) => {
  const directory = await mkdtemp(join(dirname(path), '.ontology-'))
  try {
    const temporary = join(directory, 'bundle.json')
    await writeFile(temporary, contents, { mode })
    await rename(temporary, path)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
}

const parseOptions = () => {
  try {
    return parseArgs({
      options: {
        input: { type: 'string', multiple: true },
        bundle: { type: 'string' },
        mode: { type: 'string', default: 'dry-run' },
        help: { type: 'boolean', short: 'h' },
      },
    }).values
  } catch {
    throw new Error(usage)
  }
}

const main = async () => {
  const values = parseOptions()
  if (values.help) {
    console.log(usage)
    return
  }
  if (!values.bundle || !values.input?.length || (values.mode !== 'dry-run' && values.mode !== 'write')) {
    throw new Error(usage)
  }

  const path = resolve(values.bundle)
  const original = await readJson(path)
  const proposals = []
  for (const file of await inputFiles(values.input)) proposals.push(await readJson(file))
  const bundle = mergeKnowledgeDeltas(original.value, proposals)
  await validateAgentsOntologyAnalyses(bundle.customAnalyses)

  const contents = serializeBundle(bundle)
  if (Buffer.byteLength(contents) > maxOntologyJsonBytes) throw new Error('Merged bundle exceeds the 1 MiB size limit')
  const changed = contents !== original.raw
  if (values.mode === 'write' && changed) {
    await writeBundle(path, contents, original.mode).catch(() => {
      throw new Error(`Could not replace bundle ${safePath(path)}`)
    })
  }
  const outcome = changed ? (values.mode === 'write' ? 'bundle updated' : 'would update bundle') : 'bundle unchanged'
  console.log(
    `Proposals validated: ${proposals.length}; SQL analyses checked: ${bundle.customAnalyses.length}; ${outcome}.`,
  )
}

if (import.meta.main) await main().catch((error) => fatal('Ontology curation failed.', error))
