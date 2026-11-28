import { lstat, readFile } from 'node:fs/promises'
import { basename, join } from 'node:path'

import { format } from 'oxfmt'

import formatterConfig from '../../../../.oxfmtrc.json'
import { declaredRelation, readSelectRelations } from './ontology-bundle-sql'
import { readMigrationRelations } from './ontology-migration-relations'

const migrations = new Map([
  ['agents', 'services/agents/src/server/migrations'],
  ['bayn', 'services/bayn/migrations'],
])
const maxRuleTagLength = 25
const bundleFiles = new Bun.Glob('docs/*/ontology/*knowledge*.json')
const { printWidth, tabWidth, useTabs } = formatterConfig

const credentialPrefix = /\b(?:auto_ontology_|sk-|AKIA|gh[pousr]_|github_pat_)/u
const credentialInPattern = /\b(?:auto_ontology_|sk-|AKIA|gh[pousr]_|github_pat_)[\w-]/u
const secrets = [/\bbearer\s/i, /\b[a-z][a-z0-9+.-]*:\/\/[^\s/@:]*:[^\s/@]+@/i]
const personalData = [/\b[\w.%+-]+@[\w.-]+\.[a-z]{2,}\b/i, /\b\d{3}-(?:\d{2}-\d{4}|\d{3}-\d{4})\b/u]

type JsonObject = Record<string, unknown>
const isObject = (value: unknown): value is JsonObject =>
  value !== null && typeof value === 'object' && !Array.isArray(value)

const isSensitive = (value: string, isSchemaPattern = false) =>
  (isSchemaPattern ? credentialInPattern : credentialPrefix).test(value) ||
  (isSchemaPattern ? /-----BEGIN [A-Z0-9 ]+-----/u : /-----BEGIN/u).test(value) ||
  secrets.some((pattern) => pattern.test(value)) ||
  personalData.some((pattern) => pattern.test(value))

const rejectDisclosure = () => {
  throw new Error('Possible credential or personal data; remove it before committing')
}

const checkDisclosure = (value: unknown, schema: boolean) => {
  const pending: { value: unknown; pattern?: boolean }[] = [{ value }]
  for (const item of pending) {
    if (typeof item.value === 'string' && isSensitive(item.value, item.pattern)) {
      rejectDisclosure()
    }
    if (Array.isArray(item.value)) {
      for (const child of item.value) pending.push({ value: child })
    } else if (isObject(item.value)) {
      for (const [key, child] of Object.entries(item.value)) {
        pending.push({ value: key }, { value: child, pattern: schema && key === 'pattern' })
      }
    }
  }
}

const object = (value: unknown, path: string, required: string[], optional: string[] = [], ordered = false) => {
  if (!isObject(value)) throw new Error(`${path}: expected an object`)
  for (const key of required) if (!Object.hasOwn(value, key)) throw new Error(`${path}: missing ${key}`)
  const keys = Object.keys(value)
  const allowed = [...required, ...optional]
  if (keys.some((key) => !allowed.includes(key))) throw new Error(`${path}: unexpected field`)
  if (ordered && keys.join() !== allowed.filter((key) => Object.hasOwn(value, key)).join()) {
    throw new Error(`${path}: use the Bayn schema field order`)
  }
  return value
}

const text = (value: unknown, path: string) => {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${path}: expected non-empty text`)
  return value
}

const entries = (value: unknown, path: string, nonEmpty = false): unknown[] => {
  if (!Array.isArray(value) || (nonEmpty && value.length === 0)) {
    throw new Error(`${path}: expected ${nonEmpty ? 'a non-empty' : 'an'} array`)
  }
  return value
}

const checkEvidence = (value: JsonObject, path: string, bayn: boolean) => {
  const sha = bayn ? /^[0-9a-f]{40}$/ : /^[0-9a-f]{7,40}$/i
  if (typeof value.sourceCommit !== 'string' || !sha.test(value.sourceCommit)) {
    throw new Error(`${path}.sourceCommit: expected a Git commit SHA`)
  }
  text(value.verificationNote, `${path}.verificationNote`)
}

const readTableList = (value: unknown, path: string) => {
  const relations = new Set<string>()
  for (const [index, item] of entries(value, path).entries()) {
    const location = `${path}[${index}]`
    const relation = declaredRelation(text(item, location))
    if (!relation) throw new Error(`${location}: expected a table name, optionally schema-qualified`)
    if (relations.has(relation)) throw new Error(`${location}: duplicate table name`)
    relations.add(relation)
  }
  return relations
}

const sourceLink =
  /^https:\/\/github\.com\/proompteng\/lab\/(?:pull\/[1-9]\d*|blob\/[a-f0-9]{40}\/[\w./-]+(?:#L\d+(?:-L\d+)?)?)$/
const baynEntryKeys = {
  acronym: ['name', 'description', 'sources'],
  rule: ['key', 'description', 'searchTerm', 'sources'],
  analysis: ['name', 'description', 'sql', 'referencedTables', 'sources'],
}

const checkBundle = async (
  source: string,
  file: string,
  owner: string,
  migrationRelations: () => Promise<ReadonlySet<string> | undefined>,
) => {
  let value: unknown
  try {
    value = JSON.parse(source)
  } catch {
    throw new Error('Invalid JSON')
  }

  const schema = file.endsWith('.schema.json')
  checkDisclosure(value, schema)
  const bayn = owner === 'bayn'
  const delta = file.includes('knowledge-delta')
  const sorted = JSON.stringify(
    value,
    (_, child: unknown) =>
      !bayn && !schema && isObject(child)
        ? Object.fromEntries(Object.entries(child).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)))
        : child,
    2,
  )
  // Reprint the parsed value so duplicate keys and ambiguous JSON spellings cannot pass formatting.
  const canonical = await format('knowledge.json', sorted, { printWidth, tabWidth, useTabs }).catch(() => undefined)
  if (!canonical || canonical.errors.length || source !== canonical.code) {
    throw new Error(
      `Expected canonical JSON (repository oxfmt layout${bayn || schema ? '' : ', alphabetically sorted keys'})`,
    )
  }

  if (schema) {
    const document = object(
      value,
      'schema',
      ['$schema', 'type', 'properties', 'required'],
      ['title', 'additionalProperties', '$defs', 'description'],
    )
    const properties = document.properties
    if (
      !delta ||
      document.$schema !== 'https://json-schema.org/draft/2020-12/schema' ||
      document.type !== 'object' ||
      !isObject(properties) ||
      !Object.values(properties).every((property) => typeof property === 'boolean' || isObject(property)) ||
      !entries(document.required, 'schema.required', true).every(
        (key) => typeof key === 'string' && Object.hasOwn(properties, key),
      )
    ) {
      throw new Error('Expected a knowledge-delta JSON Schema, not bundle data')
    }
    return
  }

  const verifyRelations = async (relations: ReadonlySet<string>, path: string) => {
    if (!relations.size) return
    const available = await migrationRelations()
    if (available && [...relations].some((table) => !available.has(table))) {
      throw new Error(`${path}: a table or view is not declared by the owning service's migrations`)
    }
  }

  const checkList = async (value: unknown, path: string) => {
    const relations = readTableList(value, path)
    await verifyRelations(relations, path)
    return relations
  }

  const checkEntry = async (
    value: unknown,
    path: string,
    kind: 'acronym' | 'rule' | 'analysis',
    deltaRelations?: ReadonlySet<string>,
  ) => {
    const analysis = kind === 'analysis'
    const name = bayn && kind === 'rule' ? 'key' : 'name'
    const required = bayn
      ? [...(delta ? ['kind'] : []), ...baynEntryKeys[kind]]
      : ['description', 'name', ...(analysis ? ['sql'] : [])]
    const optional = bayn
      ? []
      : [
          ...(analysis ? ['referencedTables'] : []),
          ...(!delta ? ['provenance', ...(kind === 'rule' ? ['searchTerm'] : [])] : []),
        ]
    const entry = object(value, path, required, optional, bayn)
    text(entry[name], `${path}.${name}`)
    text(entry.description, `${path}.description`)
    if (bayn) {
      if (kind === 'rule') text(entry.searchTerm, `${path}.searchTerm`)
      if (
        entries(entry.sources, `${path}.sources`, true).some(
          (link) => typeof link !== 'string' || !sourceLink.test(link),
        )
      ) {
        throw new Error(`${path}.sources: expected pinned repository evidence links`)
      }
    }
    if (entry.provenance !== undefined) {
      const location = `${path}.provenance`
      checkEvidence(object(entry.provenance, location, ['sourceCommit', 'verificationNote']), location, false)
    }
    if (entry.searchTerm !== undefined) text(entry.searchTerm, `${path}.searchTerm`)
    if (!analysis) return

    let relations: ReadonlySet<string>
    const sql = text(entry.sql, `${path}.sql`)
    try {
      relations = await readSelectRelations(sql, (value) => {
        if (isSensitive(value)) rejectDisclosure()
      })
    } catch (error) {
      throw new Error(`${path}.sql: ${error instanceof Error ? error.message : 'Invalid SQL'}`)
    }
    await verifyRelations(relations, `${path}.sql`)
    if (entry.referencedTables !== undefined) {
      const declared = await checkList(entry.referencedTables, `${path}.referencedTables`)
      if (
        (bayn && !declared.size) ||
        declared.size !== relations.size ||
        [...relations].some((table) => !declared.has(table))
      ) {
        throw new Error(`${path}.referencedTables: must match the SQL table dependencies`)
      }
    }
    if (deltaRelations && [...relations].some((table) => !deltaRelations.has(table))) {
      throw new Error(`${path}.sql: a SQL table dependency is missing from the delta referencedTables`)
    }
  }

  const sections = [
    ['acronyms', 'acronym'],
    ['rules', 'rule'],
    [bayn ? 'analyses' : 'customAnalyses', 'analysis'],
  ] as const
  const sectionKeys = sections.map(([key]) => key)
  if (delta && bayn) {
    const proposal = object(
      value,
      'delta',
      ['schemaVersion', 'sourceCommit', 'referencedTables', 'verificationNote', 'changes'],
      [],
      true,
    )
    if (proposal.schemaVersion !== 'bayn.ontology.knowledge-delta.v1') throw new Error('Unsupported Bayn delta version')
    checkEvidence(proposal, 'delta', true)
    const declared = await checkList(proposal.referencedTables, 'delta.referencedTables')
    for (const [index, change] of entries(proposal.changes, 'delta.changes', true).entries()) {
      const path = `changes[${index}]`
      const kind = isObject(change) ? change.kind : undefined
      if (kind !== 'acronym' && kind !== 'rule' && kind !== 'analysis')
        throw new Error(`${path}: unrecognized change kind`)
      await checkEntry(change, path, kind, declared)
    }
    return
  }

  let bundle: JsonObject
  if (delta) {
    bundle = object(
      value,
      'delta',
      ['kind', 'sourceCommit', 'verificationNote', 'version'],
      [...sectionKeys, 'referencedTables'],
    )
    if (bundle.kind !== 'knowledge-delta' || bundle.version !== 1)
      throw new Error('Unsupported knowledge delta version')
    checkEvidence(bundle, 'delta', false)
    if (!sectionKeys.some((key) => Object.hasOwn(bundle, key)))
      throw new Error('delta: expected at least one knowledge entry')
  } else if (bayn) {
    bundle = object(value, 'bundle', ['schemaVersion', ...sectionKeys], [], true)
    if (bundle.schemaVersion !== 'bayn.ontology.knowledge.v1') throw new Error('Unsupported Bayn bundle version')
  } else {
    bundle = object(
      value,
      'bundle',
      [...sectionKeys, 'version', ...(owner === 'agents' ? ['dataSource'] : [])],
      owner === 'agents' ? ['database', 'ruleTag'] : ['dataSource', 'database', 'ruleTag'],
    )
    if (bundle.version !== 1) throw new Error('Unsupported knowledge bundle version')
    if (owner === 'agents' && bundle.dataSource !== 'agents-db-next')
      throw new Error('bundle.dataSource: expected agents-db-next')
    const dataSource = bundle.dataSource !== undefined ? text(bundle.dataSource, 'bundle.dataSource') : undefined
    if (bundle.database !== undefined) text(bundle.database, 'bundle.database')
    const ruleTag = bundle.ruleTag !== undefined ? text(bundle.ruleTag, 'bundle.ruleTag').trim() : undefined
    const resolvedRuleTag = ruleTag ?? (dataSource !== undefined ? `${dataSource} canonical rule` : undefined)
    if (resolvedRuleTag !== undefined && resolvedRuleTag.length > maxRuleTagLength) {
      throw new Error(`bundle.ruleTag: canonical rule tag must be at most ${maxRuleTagLength} characters`)
    }
  }

  const declared =
    bundle.referencedTables === undefined
      ? undefined
      : await checkList(bundle.referencedTables, 'delta.referencedTables')
  for (const [key, kind] of sections) {
    if (delta && !Object.hasOwn(bundle, key)) continue
    for (const [index, entry] of entries(bundle[key], key, bayn || delta).entries()) {
      await checkEntry(entry, `${key}[${index}]`, kind, declared)
    }
  }
}

export const validateOntologyBundles = async (root: string) => {
  const files = [...bundleFiles.scanSync({ cwd: root, dot: true, onlyFiles: false })].sort()
  const catalogs = new Map<string, Promise<ReadonlySet<string>>>()
  const errors: string[] = []
  const decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true })
  for (const file of files) {
    const label = isSensitive(file) ? '<redacted bundle path>' : JSON.stringify(file)
    const path = join(root, file)
    const owner = file.split('/')[1] ?? ''
    try {
      let source: string
      try {
        if (!(await lstat(path)).isFile()) throw new Error('Expected a regular file')
        source = decoder.decode(await readFile(path))
      } catch {
        throw new Error('Could not read a regular UTF-8 JSON file')
      }
      await checkBundle(source, basename(file), owner, async () => {
        const directory = migrations.get(owner)
        if (!directory) return undefined
        let catalog = catalogs.get(owner)
        if (!catalog) {
          catalog = readMigrationRelations(join(root, directory))
          catalogs.set(owner, catalog)
        }
        return catalog
      })
    } catch (error) {
      errors.push(`${label}: ${error instanceof Error ? error.message : 'Validation failed'}`)
    }
  }
  return { files: files.length, errors }
}

if (import.meta.main) {
  try {
    const result = await validateOntologyBundles(process.cwd())
    for (const error of result.errors) console.error(error)
    if (result.errors.length) {
      console.error(`Ontology validation failed: ${result.errors.length} of ${result.files} file(s)`)
      process.exitCode = 1
    } else {
      console.log(`Validated ${result.files} ontology knowledge file(s)`)
    }
  } catch {
    console.error('Could not discover ontology knowledge files')
    process.exitCode = 1
  }
}
