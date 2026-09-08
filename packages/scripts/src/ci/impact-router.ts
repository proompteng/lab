import { appendFileSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'

export type ImpactTargetKind = 'delegated' | 'planner' | 'validation'

export type ImpactTarget = {
  kind: ImpactTargetKind
  exclude?: string[]
  paths: string[]
  workflow?: string
}

export type ImpactMap = {
  version: number
  targets: Record<string, ImpactTarget>
}

export type ImpactPlan = {
  files: string[]
  validationTargets: string[]
  delegatedWorkflows: string[]
}

const escapeRegExp = (value: string): string => value.replace(/[|\\{}()[\]^$+?.]/g, '\\$&')

/** Match the small glob dialect used by .github/ci/impact-map.yml. */
export const globToRegExp = (glob: string): RegExp => {
  const ownsDirectory = glob.endsWith('/**')
  const source = ownsDirectory ? glob.slice(0, -3) : glob
  let pattern = ''
  for (let index = 0; index < source.length; index += 1) {
    const character = source[index]
    const next = source[index + 1]

    if (character === '*' && next === '*') {
      if (source[index + 2] === '/') {
        pattern += '(?:.*/)?'
        index += 2
      } else {
        pattern += '.*'
        index += 1
      }
      continue
    }

    if (character === '*') {
      pattern += '[^/]*'
      continue
    }

    if (character === '?') {
      pattern += '[^/]'
      continue
    }

    pattern += escapeRegExp(character)
  }

  return new RegExp(`^${pattern}${ownsDirectory ? '(?:/.*)?' : ''}$`)
}

export const matchesGlob = (file: string, glob: string): boolean => globToRegExp(glob).test(file)

const sortUnique = (values: Iterable<string>): string[] => [...new Set(values)].sort()

export const loadImpactMap = (mapPath: string): ImpactMap => {
  const parsed = Bun.YAML.parse(readFileSync(mapPath, 'utf8')) as Partial<ImpactMap> | null
  if (!parsed || parsed.version !== 1 || !parsed.targets || typeof parsed.targets !== 'object') {
    throw new Error(`Invalid impact map: ${mapPath}`)
  }

  for (const [name, target] of Object.entries(parsed.targets)) {
    if (!target || !['delegated', 'planner', 'validation'].includes(target.kind)) {
      throw new Error(`Invalid impact target kind for ${name}`)
    }
    if (!Array.isArray(target.paths)) {
      throw new Error(`Impact target ${name} must define paths`)
    }
    if (target.exclude !== undefined && !Array.isArray(target.exclude)) {
      throw new Error(`Impact target ${name} exclude must be an array`)
    }
    if (target.kind === 'delegated' && !target.workflow) {
      throw new Error(`Delegated impact target ${name} must define workflow`)
    }
  }

  return parsed as ImpactMap
}

export const selectImpactPlan = (changedFiles: Iterable<string>, map: ImpactMap): ImpactPlan => {
  const files = sortUnique([...changedFiles].map((file) => file.trim()).filter(Boolean))
  const validationTargets = new Set<string>()
  const delegatedWorkflows = new Set<string>()

  for (const [name, target] of Object.entries(map.targets)) {
    if (target.kind === 'planner') continue
    const ownsFile = target.paths.some((glob) =>
      files.some(
        (file) =>
          matchesGlob(file, glob) && !(target.exclude ?? []).some((excludedGlob) => matchesGlob(file, excludedGlob)),
      ),
    )
    if (!ownsFile) continue

    if (target.kind === 'validation') validationTargets.add(name)
    if (target.kind === 'delegated' && target.workflow) delegatedWorkflows.add(target.workflow)
  }

  if (validationTargets.size === 0) validationTargets.add('planner')

  return {
    files,
    validationTargets: sortUnique(validationTargets),
    delegatedWorkflows: sortUnique(delegatedWorkflows),
  }
}

const readArg = (args: string[], name: string): string | undefined => {
  const index = args.indexOf(name)
  return index >= 0 ? args[index + 1] : undefined
}

const writeOutput = (path: string, key: string, value: string): void => {
  appendFileSync(path, `${key}=${value}\n`)
}

const main = (): void => {
  const args = process.argv.slice(2)
  const filesPath = readArg(args, '--files')
  const mapPath = readArg(args, '--map') ?? '.github/ci/impact-map.yml'
  const githubOutput = readArg(args, '--github-output')
  if (!filesPath) throw new Error('Usage: impact-router.ts --files <path> [--map <path>] [--github-output <path>]')

  const plan = selectImpactPlan(
    readFileSync(resolve(filesPath), 'utf8').split(/\r?\n/),
    loadImpactMap(resolve(mapPath)),
  )
  process.stdout.write(`${JSON.stringify(plan)}\n`)

  if (githubOutput) {
    writeOutput(githubOutput, 'targets', JSON.stringify(plan.validationTargets))
    writeOutput(githubOutput, 'delegated', JSON.stringify(plan.delegatedWorkflows))
    writeOutput(githubOutput, 'changed_files', JSON.stringify(plan.files))
  }
}

if (import.meta.main) main()
