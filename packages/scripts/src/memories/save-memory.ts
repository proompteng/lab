#!/usr/bin/env bun

import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

import { ensureCli, fatal, repoRoot, run } from '../shared/cli'

type Options = {
  taskName: string
  content: string
  summary: string
  tags: string
}

const usage = () =>
  `
Usage:
  bun run packages/scripts/src/memories/save-memory.ts --task-name <name> --content <text> --summary <text> [--tags <csv>]

Options:
  --task-name <name>     Task name for the memory entry (required)
  --content <text>       Full memory content (required)
  --content-file <path>  Read content from a file
  --summary <text>       Short summary (required)
  --summary-file <path>  Read summary from a file
  --tags <csv>           Comma-separated tags
  -h, --help             Show this help message

Examples:
  bun run packages/scripts/src/memories/save-memory.ts --task-name example --content "details" --summary "summary" --tags "bumba,atlas"
  bun run packages/scripts/src/memories/save-memory.ts --task-name example --content-file ./content.txt --summary "summary"
`.trim()

const readValue = (arg: string, argv: string[], index: number) => {
  const value = argv[index + 1]
  if (!value || value.startsWith('-')) {
    fatal(`${arg} requires a value`)
  }
  return value
}

const readFileValue = (path: string) => {
  try {
    return readFileSync(resolve(path), 'utf8')
  } catch (error) {
    fatal(`Failed to read file: ${path}`, error)
  }
}

const parseArgs = (argv: string[]): Options => {
  const options: Partial<Options> = {
    tags: '',
  }

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    if (!arg) continue

    if (arg === '--help' || arg === '-h') {
      console.log(usage())
      process.exit(0)
    }

    if (arg === '--task-name') {
      options.taskName = readValue(arg, argv, i)
      i += 1
      continue
    }

    if (arg.startsWith('--task-name=')) {
      options.taskName = arg.slice('--task-name='.length)
      continue
    }

    if (arg === '--content') {
      options.content = readValue(arg, argv, i)
      i += 1
      continue
    }

    if (arg.startsWith('--content=')) {
      options.content = arg.slice('--content='.length)
      continue
    }

    if (arg === '--content-file') {
      options.content = readFileValue(readValue(arg, argv, i))
      i += 1
      continue
    }

    if (arg.startsWith('--content-file=')) {
      options.content = readFileValue(arg.slice('--content-file='.length))
      continue
    }

    if (arg === '--summary') {
      options.summary = readValue(arg, argv, i)
      i += 1
      continue
    }

    if (arg.startsWith('--summary=')) {
      options.summary = arg.slice('--summary='.length)
      continue
    }

    if (arg === '--summary-file') {
      options.summary = readFileValue(readValue(arg, argv, i))
      i += 1
      continue
    }

    if (arg.startsWith('--summary-file=')) {
      options.summary = readFileValue(arg.slice('--summary-file='.length))
      continue
    }

    if (arg === '--tags') {
      options.tags = readValue(arg, argv, i)
      i += 1
      continue
    }

    if (arg.startsWith('--tags=')) {
      options.tags = arg.slice('--tags='.length)
      continue
    }

    fatal(`Unknown option: ${arg}`)
  }

  if (!options.taskName) {
    fatal('Missing --task-name')
  }

  if (!options.content) {
    fatal('Missing --content or --content-file')
  }

  if (!options.summary) {
    fatal('Missing --summary or --summary-file')
  }

  return options as Options
}

export const saveMemory = async (options: Options) => {
  ensureCli('bun')

  await run(
    'bun',
    [
      'run',
      '--filter',
      'memories',
      'save-memory',
      '--task-name',
      options.taskName,
      '--content',
      options.content,
      '--summary',
      options.summary,
      '--tags',
      options.tags,
    ],
    { cwd: repoRoot },
  )
}

const main = async () => {
  const options = parseArgs(Bun.argv.slice(2))
  await saveMemory(options)
}

main().catch((error) => fatal('Failed to save memory', error))
