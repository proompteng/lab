#!/usr/bin/env bun

import { readFile } from 'node:fs/promises'
import { relative, resolve } from 'node:path'
import YAML from 'yaml'

import { fatal, repoRoot } from '../shared/cli'

type FilterRule = {
  dependency: string
  path: string
  type: string
  values: string[]
}

type RawFilterRule = {
  path?: string
  type?: string
  value?: unknown
}

type SensorDependency = {
  name?: string
  filters?: {
    data?: RawFilterRule[]
  }
}

type SensorDocument = {
  spec?: {
    dependencies?: SensorDependency[]
  }
}

const sensorPath = resolve(
  repoRoot,
  process.env.ARGO_EVENTS_SENSOR_PATH ?? 'argocd/applications/froussard/workflow-completions-sensor.yaml',
)
const fixturePath = resolve(
  repoRoot,
  process.env.ARGO_EVENTS_FIXTURE_PATH ?? 'packages/scripts/fixtures/argo-events/workflow-completion.json',
)

const regexMetaPattern = /[.*+?^${}()|[\]\\]/

const isRegexValue = (value: string) => regexMetaPattern.test(value)

const normalizeValues = (value: unknown): string[] => {
  if (Array.isArray(value)) {
    return value.map((entry) => String(entry))
  }
  if (value === undefined || value === null) {
    return []
  }
  return [String(value)]
}

const resolvePath = (source: unknown, path: string): { found: boolean; value?: unknown } => {
  const segments = path.split('.').filter(Boolean)
  let current: unknown = source

  for (const segment of segments) {
    if (current === null || current === undefined) {
      return { found: false }
    }

    if (Array.isArray(current) && /^\d+$/.test(segment)) {
      const index = Number.parseInt(segment, 10)
      current = current[index]
      continue
    }

    const match = segment.match(/^([^[]+)(?:\[(\d+)\])?$/)
    if (!match) {
      return { found: false }
    }

    const key = match[1]
    const rawIndex = match[2]
    if (!key || typeof current !== 'object') {
      return { found: false }
    }

    const record = current as Record<string, unknown>
    if (!(key in record)) {
      return { found: false }
    }
    current = record[key]

    if (rawIndex !== undefined) {
      if (!Array.isArray(current)) {
        return { found: false }
      }
      const index = Number.parseInt(rawIndex, 10)
      current = current[index]
    }
  }

  if (current === undefined) {
    return { found: false }
  }

  return { found: true, value: current }
}

const extractRules = (doc: SensorDocument): FilterRule[] => {
  const dependencies = doc?.spec?.dependencies ?? []
  const rules: FilterRule[] = []

  for (const dependency of dependencies) {
    const name = dependency?.name ?? 'unknown-dependency'
    const dataFilters = dependency?.filters?.data ?? []
    for (const filter of dataFilters) {
      const path = typeof filter.path === 'string' ? filter.path : ''
      const type = typeof filter.type === 'string' ? filter.type : ''
      const values = normalizeValues(filter.value)

      rules.push({ dependency: name, path, type, values })
    }
  }

  return rules
}

const evaluateRule = (rule: FilterRule, payload: unknown): string | null => {
  if (!rule.path) {
    return 'missing filter path'
  }
  if (!rule.type) {
    return `missing filter type for ${rule.path}`
  }

  if (rule.values.length === 0) {
    return `missing filter values for ${rule.path}`
  }

  const resolved = resolvePath(payload, rule.path)
  if (!resolved.found) {
    return `path not found: ${rule.path}`
  }

  const value = resolved.value
  const normalizedType = rule.type.toLowerCase()
  if (normalizedType !== 'string') {
    return `unsupported filter type '${rule.type}' for ${rule.path}`
  }

  if (typeof value !== 'string') {
    return `expected string at ${rule.path}, got ${typeof value}`
  }

  const failures: string[] = []
  for (const expected of rule.values) {
    if (isRegexValue(expected)) {
      try {
        if (new RegExp(expected).test(value)) {
          return null
        }
      } catch (error) {
        failures.push(`invalid regex '${expected}': ${error instanceof Error ? error.message : String(error)}`)
      }
    } else if (value === expected) {
      return null
    }
  }

  if (failures.length > 0) {
    return failures.join('; ')
  }

  return `value '${value}' did not match ${rule.values.map((entry) => `'${entry}'`).join(', ')}`
}

const main = async () => {
  const [sensorRaw, fixtureRaw] = await Promise.all([readFile(sensorPath, 'utf8'), readFile(fixturePath, 'utf8')])

  const sensorDoc = YAML.parse(sensorRaw) as SensorDocument
  if (!sensorDoc) {
    fatal(`Unable to parse sensor manifest at ${relative(repoRoot, sensorPath)}`)
  }

  const fixture = JSON.parse(fixtureRaw) as unknown
  const rules = extractRules(sensorDoc)

  if (rules.length === 0) {
    fatal(`No data filters found in ${relative(repoRoot, sensorPath)}`)
  }

  const failures: string[] = []
  for (const rule of rules) {
    const failure = evaluateRule(rule, fixture)
    if (failure) {
      failures.push(`[${rule.dependency}] ${failure}`)
    }
  }

  if (failures.length > 0) {
    console.error('Argo Events workflow completion filter validation failed:')
    for (const failure of failures) {
      console.error(`- ${failure}`)
    }
    process.exit(1)
  }

  console.log(`Validated ${rules.length} workflow completion filter(s) against ${relative(repoRoot, fixturePath)}.`)
}

if (import.meta.main) {
  main().catch((error) => fatal('Failed to validate workflow completion filters', error))
}
