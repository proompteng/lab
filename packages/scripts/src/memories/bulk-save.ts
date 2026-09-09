#!/usr/bin/env bun

import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

import YAML from 'yaml'

import { fatal } from '../shared/cli'
import { saveMemory } from './save-memory'

type BulkItem = {
  taskName?: string
  content?: string
  summary?: string
  tags?: string | string[]
}

type BulkInput = BulkItem[] | { memories?: BulkItem[] }

type Options = {
  filePath: string
}

const usage = () =>
  `
Usage:
  bun run packages/scripts/src/memories/bulk-save.ts --file <path>

File format:
  - JSON or YAML containing an array of items, or { memories: [...] }
  - Each item: { taskName, content, summary, tags }
  - tags can be a comma-separated string or a list of strings

Examples:
  bun run packages/scripts/src/memories/bulk-save.ts --file ./memories.yml
`.trim()

const readValue = (arg: string, argv: string[], index: number) => {
  const value = argv[index + 1]
  if (!value || value.startsWith('-')) {
    fatal(`${arg} requires a value`)
  }
  return value
}

const parseArgs = (argv: string[]): Options => {
  const options: Partial<Options> = {}

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    if (!arg) continue

    if (arg === '--help' || arg === '-h') {
      console.log(usage())
      process.exit(0)
    }

    if (arg === '--file') {
      options.filePath = readValue(arg, argv, i)
      i += 1
      continue
    }

    if (arg.startsWith('--file=')) {
      options.filePath = arg.slice('--file='.length)
      continue
    }

    fatal(`Unknown option: ${arg}`)
  }

  if (!options.filePath) {
    fatal('Missing --file')
  }

  return options as Options
}

const parseInput = (filePath: string): BulkItem[] => {
  const absolutePath = resolve(filePath)
  let raw: string
  try {
    raw = readFileSync(absolutePath, 'utf8')
  } catch (error) {
    fatal(`Failed to read input file: ${absolutePath}`, error)
  }

  let parsed: BulkInput
  try {
    parsed = YAML.parse(raw) as BulkInput
  } catch (error) {
    fatal(`Failed to parse input file: ${absolutePath}`, error)
  }

  if (Array.isArray(parsed)) {
    return parsed
  }

  if (parsed && Array.isArray(parsed.memories)) {
    return parsed.memories
  }

  fatal('Input file must be an array or an object with a memories array')
}

const normalizeTags = (tags?: string | string[]) => {
  if (!tags) return ''
  if (Array.isArray(tags)) {
    return tags.join(',')
  }
  return tags
}

const normalizeItem = (item: BulkItem, index: number) => {
  if (!item.taskName) {
    fatal(`Missing taskName for item #${index + 1}`)
  }
  if (!item.content) {
    fatal(`Missing content for item #${index + 1}`)
  }
  if (!item.summary) {
    fatal(`Missing summary for item #${index + 1}`)
  }
  return {
    taskName: item.taskName,
    content: item.content,
    summary: item.summary,
    tags: normalizeTags(item.tags),
  }
}

const main = async () => {
  const options = parseArgs(Bun.argv.slice(2))
  const items = parseInput(options.filePath)

  if (items.length === 0) {
    console.log('No memories to save (input list is empty).')
    return
  }

  for (const [index, item] of items.entries()) {
    const normalized = normalizeItem(item, index)
    console.log(`Saving memory ${index + 1}/${items.length}: ${normalized.taskName}`)
    await saveMemory(normalized)
  }
}

main().catch((error) => fatal('Failed to save memories in bulk', error))
