#!/usr/bin/env bun

import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import process from 'node:process'

import { fatal, repoRoot } from '../shared/cli'

const defaultPolicyFile = 'argocd/applicationsets/product.yaml'
const defaultRequirement = 'jangar=auto'

type Requirement = {
  app: string
  mode: string
}

type CliOptions = {
  filePath?: string
  requirements: Requirement[]
}

const resolvePath = (path: string) => resolve(repoRoot, path)

const normalizeValue = (value: string): string => value.trim().replace(/^['"]|['"]$/g, '')

export const parseAutomationModes = (source: string): Map<string, string> => {
  const lines = source.split(/\r?\n/)
  const modes = new Map<string, string>()

  let currentApp: string | undefined
  let currentIndent = 0

  for (const line of lines) {
    const appMatch = line.match(/^(\s*)-\s+name:\s*([^\s#]+)/)
    if (appMatch) {
      currentApp = normalizeValue(appMatch[2])
      currentIndent = appMatch[1].length
      continue
    }

    if (!currentApp) {
      continue
    }

    const trimmed = line.trim()
    const leadingSpaces = line.match(/^(\s*)/)?.[1].length ?? 0
    if (trimmed && !trimmed.startsWith('#') && leadingSpaces <= currentIndent) {
      currentApp = undefined
      continue
    }

    const automationMatch = line.match(/^\s*automation:\s*([^\s#]+)/)
    if (automationMatch) {
      modes.set(currentApp, normalizeValue(automationMatch[1]))
    }
  }

  return modes
}

const parseRequirement = (raw: string): Requirement => {
  const [appRaw, modeRaw] = raw.split('=', 2)
  const app = appRaw?.trim()
  const mode = modeRaw?.trim()
  if (!app || !mode) {
    throw new Error(`Invalid --require value '${raw}'. Expected format <app>=<mode>`)
  }
  return {
    app,
    mode,
  }
}

const parseArgs = (argv: string[]): CliOptions => {
  const options: CliOptions = {
    requirements: [],
  }

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    if (arg === '--help' || arg === '-h') {
      console.log(`Usage: bun run packages/scripts/src/jangar/check-automation-policy.ts [options]

Options:
  --file <path>              Path to ApplicationSet file (default: argocd/applicationsets/product.yaml)
  --require <app>=<mode>     Required automation mode. Can be passed multiple times.

Example:
  bun run packages/scripts/src/jangar/check-automation-policy.ts --require jangar=auto`)
      process.exit(0)
    }

    if (!arg.startsWith('--')) {
      throw new Error(`Unknown argument: ${arg}`)
    }

    const [flag, inlineValue] = arg.includes('=') ? arg.split(/=(.*)/s, 2) : [arg, undefined]
    const value = inlineValue ?? argv[i + 1]
    if (inlineValue === undefined) {
      i += 1
    }
    if (value === undefined) {
      throw new Error(`Missing value for ${flag}`)
    }

    switch (flag) {
      case '--file':
        options.filePath = value
        break
      case '--require':
        options.requirements.push(parseRequirement(value))
        break
      default:
        throw new Error(`Unknown option: ${flag}`)
    }
  }

  if (options.requirements.length === 0) {
    options.requirements.push(parseRequirement(defaultRequirement))
  }

  return options
}

const main = (cliOptions?: CliOptions) => {
  const parsed = cliOptions ?? parseArgs(process.argv.slice(2))
  const filePath = resolvePath(parsed.filePath ?? defaultPolicyFile)
  const source = readFileSync(filePath, 'utf8')
  const modes = parseAutomationModes(source)

  for (const requirement of parsed.requirements) {
    const actual = modes.get(requirement.app)
    if (!actual) {
      throw new Error(`App '${requirement.app}' was not found in ${parsed.filePath ?? defaultPolicyFile}`)
    }

    if (actual !== requirement.mode) {
      throw new Error(
        `Automation mode mismatch for '${requirement.app}': expected '${requirement.mode}', found '${actual}'`,
      )
    }
  }

  for (const requirement of parsed.requirements) {
    console.log(`Automation policy ok: ${requirement.app}=${requirement.mode}`)
  }
}

if (import.meta.main) {
  try {
    main()
  } catch (error) {
    fatal('Automation policy check failed', error)
  }
}

export const __private = {
  parseArgs,
  parseAutomationModes,
  parseRequirement,
}
