#!/usr/bin/env bun
import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'

import { runCommand } from './runner'

type JsonMode = 'json' | 'experimental-json'

interface ParsedArgs {
  addDir: string[]
  binary: string
  help: boolean
  images: string[]
  inputFile?: string
  jsonMode: JsonMode
  model?: string
  namespace?: string
  outputSchemaPath?: string
  passthrough: string[]
  prompt?: string
  resumeLast: boolean
  sandboxMode?: string
  skipGitRepoCheck: boolean
  threadId?: string
  workingDirectory?: string
}

const DEFAULT_BINARY = 'codex'
const DEFAULT_JSON_MODE: JsonMode = 'json'

const HELP_TEXT = `Usage: cx-codex-run [options] <prompt>

Wrapper around 'codex exec' that streams JSON events.

Options:
  -h, --help                         Show this help text.
  --binary <path>                     Codex binary to invoke. [default: codex]
  --json-mode <json|experimental-json> JSON mode for Codex output. [default: json]
  --model <name>                      Model override.
  --namespace <name>                  Alias for codex config namespace override.
  --sandbox <mode>                    Sandbox mode override.
  --cd <path>                         Set working directory for execution.
  --add-dir <path>                    Add one more allowed directory.
  --output-schema <path>              Path to output schema.
  --resume-last                       Resume the last thread.
  --thread-id <id>                    Resume a specific thread.
  --skip-git-repo-check               Skip repo checks before execution.
  --image <id>                        Pass through an image arg.
  --prompt-file <path>                Read prompt text from a file.
  --                                  Pass through remaining args to codex.
`

const consumeValue = (args: string[], i: number): string => {
  const value = args[i + 1]
  if (!value || value.startsWith('-')) {
    throw new Error(`Missing value for ${args[i]}`)
  }
  return value
}

export const parseCodexRunArgs = (argv: string[]): ParsedArgs => {
  const parsed: ParsedArgs = {
    addDir: [],
    binary: DEFAULT_BINARY,
    help: false,
    images: [],
    jsonMode: DEFAULT_JSON_MODE,
    passthrough: [],
    skipGitRepoCheck: false,
    resumeLast: false,
  }

  const positional: string[] = []

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]

    if (!arg) {
      continue
    }

    if (arg === '--') {
      parsed.passthrough.push(...argv.slice(i + 1))
      break
    }

    if (!arg.startsWith('-')) {
      positional.push(arg)
      continue
    }

    if (arg === '-h' || arg === '--help') {
      parsed.help = true
      continue
    }

    if (arg.startsWith('--binary=')) {
      parsed.binary = arg.substring('--binary='.length)
      continue
    }
    if (arg === '--binary') {
      parsed.binary = consumeValue(argv, i)
      i += 1
      continue
    }

    if (arg.startsWith('--json-mode=')) {
      parsed.jsonMode = arg.substring('--json-mode='.length) as JsonMode
      continue
    }
    if (arg === '--json-mode') {
      parsed.jsonMode = consumeValue(argv, i) as JsonMode
      i += 1
      continue
    }

    if (arg === '--model') {
      parsed.model = consumeValue(argv, i)
      i += 1
      continue
    }

    if (arg.startsWith('--namespace=')) {
      parsed.namespace = arg.substring('--namespace='.length)
      continue
    }
    if (arg === '--namespace') {
      parsed.namespace = consumeValue(argv, i)
      i += 1
      continue
    }

    if (arg === '--sandbox') {
      parsed.sandboxMode = consumeValue(argv, i)
      i += 1
      continue
    }

    if (arg === '--cd' || arg === '--working-directory') {
      parsed.workingDirectory = consumeValue(argv, i)
      i += 1
      continue
    }

    if (arg === '--skip-git-repo-check') {
      parsed.skipGitRepoCheck = true
      continue
    }

    if (arg.startsWith('--add-dir=')) {
      parsed.addDir.push(arg.substring('--add-dir='.length))
      continue
    }
    if (arg === '--add-dir') {
      parsed.addDir.push(consumeValue(argv, i))
      i += 1
      continue
    }

    if (arg === '--output-schema') {
      parsed.outputSchemaPath = consumeValue(argv, i)
      i += 1
      continue
    }

    if (arg.startsWith('--output-schema=')) {
      parsed.outputSchemaPath = arg.substring('--output-schema='.length)
      continue
    }

    if (arg === '--resume-last') {
      parsed.resumeLast = true
      continue
    }

    if (arg.startsWith('--thread-id=')) {
      parsed.threadId = arg.substring('--thread-id='.length)
      continue
    }
    if (arg === '--thread-id') {
      parsed.threadId = consumeValue(argv, i)
      i += 1
      continue
    }

    if (arg.startsWith('--prompt=')) {
      parsed.prompt = arg.substring('--prompt='.length)
      continue
    }
    if (arg === '--prompt') {
      parsed.prompt = consumeValue(argv, i)
      i += 1
      continue
    }

    if (arg.startsWith('--prompt-file=')) {
      parsed.inputFile = arg.substring('--prompt-file='.length)
      continue
    }
    if (arg === '--prompt-file') {
      parsed.inputFile = consumeValue(argv, i)
      i += 1
      continue
    }

    if (arg.startsWith('--image=')) {
      parsed.images.push(arg.substring('--image='.length))
      continue
    }
    if (arg === '--image') {
      parsed.images.push(consumeValue(argv, i))
      i += 1
      continue
    }

    if (arg.startsWith('--')) {
      if (arg.includes('=')) {
        parsed.passthrough.push(arg)
      } else if (positional.length > 0 && argv[i + 1] && !argv[i + 1].startsWith('-')) {
        parsed.passthrough.push(arg, argv[i + 1])
        i += 1
      } else {
        parsed.passthrough.push(arg)
      }
      continue
    }

    parsed.passthrough.push(arg)
  }

  if (positional.length > 0) {
    parsed.prompt = positional[0]
    if (positional.length > 1) {
      throw new Error(`Unexpected positional argument: ${positional[1]}`)
    }
  }

  return parsed
}

const parseJsonMode = (value: string): JsonMode => {
  if (value !== 'json' && value !== 'experimental-json') {
    throw new Error(`Invalid --json-mode ${value}. Expected json or experimental-json`)
  }
  return value
}

export const buildCommandArgs = (options: ParsedArgs): string[] => {
  const args = ['exec', options.jsonMode === 'experimental-json' ? '--experimental-json' : '--json']

  if (options.model) {
    args.push('--model', options.model)
  }

  if (options.namespace) {
    args.push('--config', `namespace=${options.namespace}`)
  }

  if (options.sandboxMode) {
    args.push('--sandbox', options.sandboxMode)
  }

  if (options.workingDirectory) {
    args.push('--cd', options.workingDirectory)
  }

  for (const directory of options.addDir) {
    args.push('--add-dir', directory)
  }

  if (options.skipGitRepoCheck) {
    args.push('--skip-git-repo-check')
  }

  if (options.outputSchemaPath) {
    args.push('--output-schema', options.outputSchemaPath)
  }

  if (options.resumeLast) {
    args.push('resume', '--last')
  } else if (options.threadId) {
    args.push('resume', options.threadId)
  }

  args.push(...options.images.flatMap((image) => ['--image', image]))
  args.push(...options.passthrough)

  return args
}

export const parsePrompt = async (options: ParsedArgs): Promise<string> => {
  if (options.prompt && options.inputFile) {
    throw new Error('Use either --prompt or --prompt-file, not both.')
  }

  if (options.prompt) {
    return options.prompt
  }

  if (!options.inputFile) {
    throw new Error('Prompt is required. Use --prompt, --prompt-file, or pass it as the last positional argument.')
  }

  const loaded = await readFile(resolve(options.inputFile), 'utf8')
  const normalized = loaded.trimEnd()
  if (!normalized) {
    throw new Error(`Prompt file was empty: ${options.inputFile}`)
  }

  return normalized
}

export const main = async () => {
  let parsed: ParsedArgs
  try {
    parsed = parseCodexRunArgs(process.argv.slice(2))
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error))
    console.error(HELP_TEXT)
    return 1
  }

  if (parsed.help) {
    console.log(HELP_TEXT)
    return 0
  }

  try {
    const prompt = await parsePrompt(parsed)
    parsed.jsonMode = parseJsonMode(parsed.jsonMode)

    const args = buildCommandArgs(parsed)

    return await runCommand(parsed.binary, args, {
      input: prompt,
      env: {
        ...(parsed.model ? { CODEX_MODEL: parsed.model } : undefined),
      },
    })
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error))
    return 1
  }
}

if (import.meta.main) {
  const code = await main()
  process.exit(typeof code === 'number' ? code : 1)
}
