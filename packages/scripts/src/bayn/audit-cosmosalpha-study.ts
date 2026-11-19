import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { dirname, isAbsolute, relative, resolve } from 'node:path'

type ObjectValue = Record<string, unknown>
type StudyRun = { runId: string; seed: number; config: string; sha256: string }
type StudyPlan = {
  sourceCommit: string
  sourceIdentityFile: string
  sourceIdentitySha256: string
  runs: StudyRun[]
}
type Architecture = 'graph' | 'no-flow' | 'mcts' | 'chain'
type InspectedRun = {
  runId: string
  seed: number
  architecture: Architecture
  config: ObjectValue
  nativeBudget: { unit: string; maximum: number; configuredMaxProposals: number }
}
type Finding = { subject: string; detail: string }

const isObject = (value: unknown): value is ObjectValue =>
  typeof value === 'object' && value !== null && !Array.isArray(value) && !(value instanceof Date)

const object = (value: unknown, subject: string): ObjectValue => {
  if (!isObject(value)) throw new Error(`${subject} must be an object`)
  return value
}

const text = (value: unknown, subject: string): string => {
  if (typeof value !== 'string' || value.trim().length === 0) throw new Error(`${subject} must be a nonempty string`)
  return value
}

const integer = (value: unknown, subject: string): number => {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0)
    throw new Error(`${subject} must be a nonnegative safe integer`)
  return value
}

const sha256 = (value: unknown, subject: string): string => {
  const digest = text(value, subject)
  if (!/^[a-f0-9]{64}$/.test(digest)) throw new Error(`${subject} must be a SHA-256 digest`)
  return digest
}

const hash = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex')
const section = (config: ObjectValue, name: string) => object(config[name], name)

const canonical = (value: unknown): string => {
  if (value instanceof Date) return JSON.stringify(value.toISOString())
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`
  if (typeof value === 'object' && value !== null)
    return `{${Object.entries(value)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`)
      .join(',')}}`
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return JSON.stringify(value)
  if (typeof value === 'number' && Number.isFinite(value)) return JSON.stringify(value)
  throw new Error('Configuration contains an unsupported or nonfinite value')
}

const parseJson = (path: string, bytes = readFileSync(path)): unknown => {
  try {
    return JSON.parse(bytes.toString('utf8'))
  } catch (cause) {
    throw new Error(`Invalid JSON in ${path}`, { cause })
  }
}

const parsePlan = (value: unknown): StudyPlan => {
  const plan = object(value, 'plan')
  if (!Array.isArray(plan.runs) || plan.runs.length === 0) throw new Error('plan.runs must be nonempty')
  const sourceCommit = text(plan.sourceCommit, 'sourceCommit')
  if (!/^[a-f0-9]{40}$/.test(sourceCommit)) throw new Error('sourceCommit must be a Git commit SHA')
  return {
    sourceCommit,
    sourceIdentityFile: text(plan.sourceIdentityFile, 'sourceIdentityFile'),
    sourceIdentitySha256: sha256(plan.sourceIdentitySha256, 'sourceIdentitySha256'),
    runs: plan.runs.map((value) => {
      const run = object(value, 'run')
      return {
        runId: text(run.runId, 'runId'),
        seed: integer(run.seed, 'seed'),
        config: text(run.config, 'config'),
        sha256: sha256(run.sha256, 'config sha256'),
      }
    }),
  }
}

const inspectRun = (run: StudyRun, base: string): InspectedRun => {
  const path = resolve(base, run.config)
  const bytes = readFileSync(path)
  if (hash(bytes) !== run.sha256) throw new Error('Config bytes differ from the frozen plan')
  let parsed: unknown
  try {
    parsed = Bun.TOML.parse(bytes.toString('utf8'))
  } catch (cause) {
    throw new Error(`Invalid TOML in ${path}`, { cause })
  }
  const config = object(parsed, 'config')
  if (integer(section(config, 'runtime').random_seed, 'runtime.random_seed') !== run.seed)
    throw new Error('Configured seed differs from plan seed')
  const name = text(section(config, 'architecture').name, 'architecture.name')
  let architecture: Architecture
  let maximum: number
  let unit: string
  if (name === 'graph') {
    const graph = section(config, 'graph')
    const gamma = object(graph.flow, 'graph.flow').gamma
    if (typeof gamma !== 'number' || !Number.isFinite(gamma) || gamma < 0 || gamma >= 1)
      throw new Error('graph.flow.gamma must be finite and in [0, 1)')
    architecture = gamma === 0 ? 'no-flow' : 'graph'
    maximum = integer(object(graph.search, 'graph.search').max_expansion_attempts, 'graph expansion attempts')
    unit = 'parent-expansion-attempts'
    if (
      integer(object(graph.initialization, 'graph.initialization').random_seed, 'graph initialization seed') !==
      run.seed
    )
      throw new Error('Graph initialization seed differs from plan seed')
  } else if (name === 'mcts') {
    architecture = 'mcts'
    maximum = integer(section(config, 'mcts').max_iterations, 'mcts.max_iterations')
    unit = 'mcts-iterations'
  } else if (name === 'chain') {
    architecture = 'chain'
    maximum = integer(section(config, 'workflow').max_cycles, 'workflow.max_cycles')
    unit = 'serial-cycles'
  } else throw new Error(`Unsupported architecture ${name}`)
  const configuredMaxProposals = integer(section(config, 'factor_generation').max_proposals, 'max_proposals')
  if (maximum === 0 || configuredMaxProposals === 0)
    throw new Error('Native budgets and proposal count must be positive')
  section(config, 'storage')
  return {
    runId: run.runId,
    seed: run.seed,
    architecture,
    config,
    nativeBudget: { unit, maximum, configuredMaxProposals },
  }
}

const withoutFlowAndStorageRoot = (config: ObjectValue) => {
  const graph = section(config, 'graph')
  const flow = { ...object(graph.flow, 'graph.flow') }
  delete flow.gamma
  const storage = { ...section(config, 'storage') }
  delete storage.root
  return { ...config, storage, graph: { ...graph, flow } }
}

export const auditCosmosalphaStudy = (planPath: string, sourceRoot: string) => {
  const planBytes = readFileSync(planPath)
  const plan = parsePlan(parseJson(planPath, planBytes))
  const base = dirname(resolve(planPath))
  const findings: Finding[] = []
  const record = (subject: string, error: unknown) => {
    findings.push({ subject, detail: error instanceof Error ? error.message : 'Unknown input failure' })
  }
  let sourceFilesMatched = 0
  try {
    const identityPath = resolve(base, plan.sourceIdentityFile)
    const identityBytes = readFileSync(identityPath)
    if (hash(identityBytes) !== plan.sourceIdentitySha256) throw new Error('Source manifest differs from frozen plan')
    const identity = object(parseJson(identityPath, identityBytes), 'source identity')
    if (identity.sourceCommit !== plan.sourceCommit) throw new Error('Source manifest commit differs from plan')
    if (!Array.isArray(identity.files) || identity.files.length === 0)
      throw new Error('Source manifest must list files')
    const seen = new Set<string>()
    for (const raw of identity.files) {
      const file = object(raw, 'source file')
      const path = text(file.path, 'source file path')
      if (!path.startsWith('src/cosmosalpha/') || seen.has(path))
        throw new Error(`Invalid or duplicate source path ${path}`)
      seen.add(path)
      const installed = resolve(sourceRoot, path.slice('src/cosmosalpha/'.length))
      const local = relative(resolve(sourceRoot), installed)
      if (local === '..' || local.startsWith('../') || isAbsolute(local))
        throw new Error('Source path escapes package root')
      if (hash(readFileSync(installed)) !== sha256(file.sha256, 'source file sha256'))
        throw new Error(`Installed source differs from manifest: ${path}`)
      sourceFilesMatched += 1
    }
  } catch (error) {
    record('source identity', error)
  }
  const runs: InspectedRun[] = []
  const runIds = new Set<string>()
  for (const run of plan.runs) {
    try {
      if (runIds.has(run.runId)) throw new Error('Duplicate runId')
      runIds.add(run.runId)
      runs.push(inspectRun(run, base))
    } catch (error) {
      record(run.runId, error)
    }
  }
  const commonSections = [
    'data',
    'universe',
    'returns',
    'preprocessing',
    'operators',
    'factor_generation',
    'evaluation',
    'prompts',
    'llm',
    'qlib',
  ]
  const first = runs[0]
  if (first) {
    for (const name of commonSections) {
      try {
        const expected = canonical(section(first.config, name))
        for (const run of runs) {
          if (canonical(section(run.config, name)) !== expected)
            findings.push({ subject: run.runId, detail: `${name} differs from ${first.runId}` })
        }
      } catch (error) {
        record(`shared ${name}`, error)
      }
    }
  }
  for (const seed of new Set(plan.runs.map((run) => run.seed))) {
    const paired = runs.filter((run) => run.seed === seed)
    for (const architecture of ['graph', 'mcts', 'no-flow']) {
      const count = paired.filter((run) => run.architecture === architecture).length
      if (count !== 1)
        findings.push({ subject: `seed ${seed}`, detail: `Expected one ${architecture} config, found ${count}` })
    }
    const graph = paired.find((run) => run.architecture === 'graph')
    const noFlow = paired.find((run) => run.architecture === 'no-flow')
    if (
      graph &&
      noFlow &&
      canonical(withoutFlowAndStorageRoot(graph.config)) !== canonical(withoutFlowAndStorageRoot(noFlow.config))
    )
      findings.push({ subject: `seed ${seed}`, detail: 'No-Flow changes settings beyond gamma and storage root' })
  }
  return {
    scope: 'configuration-audit-only',
    bunVersion: Bun.version,
    status: findings.length === 0 ? 'configuration-consistent' : 'configuration-mismatch',
    planSha256: hash(planBytes),
    sourceCommit: plan.sourceCommit,
    sourceFilesMatched,
    runs: runs.map(({ config: _config, ...run }) => run),
    findings,
    unverified: [
      'Native config admission and actual model requests are not exercised.',
      'Paper MCTS multi-subtree behavior is not established by architecture.name=mcts.',
      'Native budget units do not establish comparable realized evaluable-factor pools.',
      'Initialization, retries, duplicates and usable-factor counts require terminal receipts.',
      'Calendar-correct labels, point-in-time lineage and untouched downstream splits require separate evidence.',
      'Method advantage, economic qualification and capital authority are not established.',
    ],
  }
}

if (import.meta.main) {
  const [plan, sourceRoot, extra] = process.argv.slice(2)
  if (plan === '--help')
    process.stdout.write('Usage: bun audit-cosmosalpha-study.ts PLAN_JSON INSTALLED_COSMOSALPHA_ROOT\n')
  else {
    try {
      if (!plan || !sourceRoot || extra) throw new Error('Expected plan JSON and installed CosmosAlpha package root')
      const report = auditCosmosalphaStudy(plan, sourceRoot)
      process.stdout.write(`${JSON.stringify(report, null, 2)}\n`)
      process.exitCode = report.findings.length === 0 ? 0 : 1
    } catch (error) {
      process.stderr.write(`${error instanceof Error ? error.message : 'Input audit failed'}\n`)
      process.exitCode = 1
    }
  }
}
