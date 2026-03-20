#!/usr/bin/env bun

import { execFileSync } from 'node:child_process'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'

type SwarmUserRecord = {
  humanName?: string
  email?: string
  team: 'jangar' | 'torghut'
  role: 'architect' | 'engineer' | 'deployer'
  workspaceToken: string
  actorId: string
}

type GeneratorOptions = {
  inputPath: string
  jangarOutputPath: string
  torghutOutputPath: string
  controllerName: string
  controllerNamespace: string
}

const DEFAULT_INPUT_PATH = '/tmp/huly-swarm-auth.json'
const DEFAULT_JANGAR_OUTPUT = 'argocd/applications/agents/huly-api-jangar-sealedsecret.yaml'
const DEFAULT_TORGHUT_OUTPUT = 'argocd/applications/agents/huly-api-torghut-sealedsecret.yaml'
const DEFAULT_CONTROLLER_NAME = 'sealed-secrets'
const DEFAULT_CONTROLLER_NAMESPACE = 'sealed-secrets'

const JANGAR_TOKEN_KEYS = {
  architect: 'HULY_API_TOKEN_VICTOR_CHEN_JANGAR_ARCHITECT',
  engineer: 'HULY_API_TOKEN_ELISE_NOVAK_JANGAR_ENGINEER',
  deployer: 'HULY_API_TOKEN_MARCO_SILVA_JANGAR_DEPLOYER',
} as const

const JANGAR_ACTOR_KEYS = {
  architect: 'HULY_EXPECTED_ACTOR_ID_VICTOR_CHEN_JANGAR_ARCHITECT',
  engineer: 'HULY_EXPECTED_ACTOR_ID_ELISE_NOVAK_JANGAR_ENGINEER',
  deployer: 'HULY_EXPECTED_ACTOR_ID_MARCO_SILVA_JANGAR_DEPLOYER',
} as const

const TORGHUT_TOKEN_KEYS = {
  architect: 'HULY_API_TOKEN_GIDEON_PARK_TORGHUT_ARCHITECT',
  engineer: 'HULY_API_TOKEN_NAOMI_IBARRA_TORGHUT_ENGINEER',
  deployer: 'HULY_API_TOKEN_JULIAN_HART_TORGHUT_DEPLOYER',
} as const

const TORGHUT_ACTOR_KEYS = {
  architect: 'HULY_EXPECTED_ACTOR_ID_GIDEON_PARK_TORGHUT_ARCHITECT',
  engineer: 'HULY_EXPECTED_ACTOR_ID_NAOMI_IBARRA_TORGHUT_ENGINEER',
  deployer: 'HULY_EXPECTED_ACTOR_ID_JULIAN_HART_TORGHUT_DEPLOYER',
} as const

const COMMON_LITERALS = {
  HULY_API_BASE_URL: 'http://transactor.huly.svc.cluster.local',
  HULY_CHANNEL: 'general',
  HULY_PROJECT: 'DefaultProject',
  HULY_TEAMSPACE: 'PROOMPTENG',
  HULY_WORKSPACE: 'proompteng',
}

const usage = () => {
  console.error(`Usage: bun scripts/generate-huly-swarm-sealed-secrets.ts [options]

Options:
  --input <path>                  JSON file with recreated swarm users (default: ${DEFAULT_INPUT_PATH})
  --jangar-output <path>          Output path for jangar sealed secret
  --torghut-output <path>         Output path for torghut sealed secret
  --controller-name <name>        Sealed Secrets controller name (default: ${DEFAULT_CONTROLLER_NAME})
  --controller-namespace <ns>     Sealed Secrets controller namespace (default: ${DEFAULT_CONTROLLER_NAMESPACE})
`)
}

const parseArgs = (): GeneratorOptions => {
  const args = Bun.argv.slice(2)
  const options: GeneratorOptions = {
    inputPath: DEFAULT_INPUT_PATH,
    jangarOutputPath: DEFAULT_JANGAR_OUTPUT,
    torghutOutputPath: DEFAULT_TORGHUT_OUTPUT,
    controllerName: DEFAULT_CONTROLLER_NAME,
    controllerNamespace: DEFAULT_CONTROLLER_NAMESPACE,
  }

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]
    const next = args[index + 1]
    switch (arg) {
      case '--input':
        if (!next) throw new Error('--input requires a value')
        options.inputPath = next
        index += 1
        break
      case '--jangar-output':
        if (!next) throw new Error('--jangar-output requires a value')
        options.jangarOutputPath = next
        index += 1
        break
      case '--torghut-output':
        if (!next) throw new Error('--torghut-output requires a value')
        options.torghutOutputPath = next
        index += 1
        break
      case '--controller-name':
        if (!next) throw new Error('--controller-name requires a value')
        options.controllerName = next
        index += 1
        break
      case '--controller-namespace':
        if (!next) throw new Error('--controller-namespace requires a value')
        options.controllerNamespace = next
        index += 1
        break
      case '--help':
      case '-h':
        usage()
        process.exit(0)
      default:
        throw new Error(`unknown argument: ${arg}`)
    }
  }

  return options
}

const assertString = (value: unknown, field: string): string => {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new Error(`missing required string field '${field}'`)
  }
  return value.trim()
}

const parseInput = (inputPath: string): SwarmUserRecord[] => {
  const raw = JSON.parse(readFileSync(inputPath, 'utf8')) as unknown
  if (!Array.isArray(raw)) {
    throw new Error('input must be a JSON array')
  }

  return raw.map((entry, index) => {
    if (!entry || typeof entry !== 'object') {
      throw new Error(`entry ${index} must be an object`)
    }

    const record = entry as Record<string, unknown>
    const team = assertString(record.team, `entry[${index}].team`)
    const role = assertString(record.role, `entry[${index}].role`)
    if (team !== 'jangar' && team !== 'torghut') {
      throw new Error(`entry ${index} has unsupported team '${team}'`)
    }
    if (role !== 'architect' && role !== 'engineer' && role !== 'deployer') {
      throw new Error(`entry ${index} has unsupported role '${role}'`)
    }

    return {
      humanName: typeof record.humanName === 'string' ? record.humanName : undefined,
      email: typeof record.email === 'string' ? record.email : undefined,
      team,
      role,
      workspaceToken: assertString(record.workspaceToken, `entry[${index}].workspaceToken`),
      actorId: assertString(record.actorId, `entry[${index}].actorId`),
    }
  })
}

const buildSecretManifest = (name: string, literals: Record<string, string>): string => {
  const args = ['create', 'secret', 'generic', name, '--namespace', 'agents', '--dry-run=client', '-o', 'yaml']
  for (const [key, value] of Object.entries(literals)) {
    args.push(`--from-literal=${key}=${value}`)
  }

  return execFileSync('kubectl', args, { encoding: 'utf8' })
}

const sealSecretManifest = (
  secretManifest: string,
  {
    controllerName,
    controllerNamespace,
  }: {
    controllerName: string
    controllerNamespace: string
  },
): string =>
  execFileSync(
    'kubeseal',
    ['--controller-name', controllerName, '--controller-namespace', controllerNamespace, '--format', 'yaml'],
    { input: secretManifest, encoding: 'utf8' },
  )

const writeOutput = (outputPath: string, content: string) => {
  const resolved = resolve(outputPath)
  mkdirSync(dirname(resolved), { recursive: true })
  writeFileSync(resolved, content)
  console.log(`Wrote ${resolved}`)
}

const buildLiteralsForTeam = (
  users: SwarmUserRecord[],
  tokenKeys: Record<SwarmUserRecord['role'], string>,
  actorKeys: Record<SwarmUserRecord['role'], string>,
) => {
  const literals: Record<string, string> = { ...COMMON_LITERALS }
  for (const role of ['architect', 'engineer', 'deployer'] as const) {
    const user = users.find((candidate) => candidate.role === role)
    if (!user) {
      throw new Error(`missing ${role} record`)
    }
    literals[tokenKeys[role]] = user.workspaceToken
    literals[actorKeys[role]] = user.actorId
  }
  return literals
}

const main = () => {
  const options = parseArgs()
  const users = parseInput(options.inputPath)

  const jangarUsers = users.filter((user) => user.team === 'jangar')
  const torghutUsers = users.filter((user) => user.team === 'torghut')

  if (jangarUsers.length !== 3) {
    throw new Error(`expected 3 jangar users, found ${jangarUsers.length}`)
  }
  if (torghutUsers.length !== 3) {
    throw new Error(`expected 3 torghut users, found ${torghutUsers.length}`)
  }

  const jangarManifest = buildSecretManifest(
    'huly-api-jangar',
    buildLiteralsForTeam(jangarUsers, JANGAR_TOKEN_KEYS, JANGAR_ACTOR_KEYS),
  )
  const torghutManifest = buildSecretManifest(
    'huly-api-torghut',
    buildLiteralsForTeam(torghutUsers, TORGHUT_TOKEN_KEYS, TORGHUT_ACTOR_KEYS),
  )

  writeOutput(
    options.jangarOutputPath,
    sealSecretManifest(jangarManifest, {
      controllerName: options.controllerName,
      controllerNamespace: options.controllerNamespace,
    }),
  )
  writeOutput(
    options.torghutOutputPath,
    sealSecretManifest(torghutManifest, {
      controllerName: options.controllerName,
      controllerNamespace: options.controllerNamespace,
    }),
  )
}

main()
