import { lstat, readFile, realpath, stat } from 'node:fs/promises'
import { isAbsolute, relative, resolve, sep } from 'node:path'

import { readSelectRelations } from './ontology-bundle-sql'

const bundleGlob = new Bun.Glob('docs/**/ontology/*-knowledge.json')
const decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true })

export const findingDescriptions = {
  'bundle-read-error': 'Could not read a regular UTF-8 bundle file inside the audit root.',
  'invalid-json': 'Expected valid JSON with unique object keys.',
  'invalid-bundle': 'Expected a supported bundle version, entry array, or field value.',
  'acronym-collision': 'The same case-insensitive acronym or alias appears in multiple bundles.',
  'citation-drift': 'A citation does not resolve to a file inside the current checkout.',
  'possible-secret': 'Possible credential or database URL; inspect and redact it locally.',
  'unsafe-sql': 'SQL is outside the supported read-only PostgreSQL SELECT subset.',
} as const

type FindingCode = keyof typeof findingDescriptions
type Location = { bundle: number; path: string; offset?: number }
export type AuditReport = {
  bundles: string[]
  findings: { code: FindingCode; locations: Location[] }[]
}

const isObject = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value)
const isText = (value: unknown): value is string => typeof value === 'string' && value.trim().length > 0
const isInside = (path: string) => path !== '' && path !== '..' && !path.startsWith(`..${sep}`) && !isAbsolute(path)

// The existing validators don't expose their disclosure checks, and the auditor also bans credential-free DB URLs.
const credentialMarkers = [
  /-----BEGIN [A-Z0-9 ]*PRIVATE KEY(?: BLOCK)?-----/i,
  /(?:auto_ontology_|gh[pousr]_|github_pat_|xox[baprs]-|nvapi-)[\w-]+|\bsk-[\w-]{8,}/i,
  /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b|\bAIza[\w-]{35}\b/u,
  /\beyJ[\w-]+\.eyJ[\w-]+\.[\w-]+\b/u,
  /\b(?:basic|bearer)\s+[\w.~+/=-]{8,}/i,
  /\b[a-z][a-z0-9+.-]*:\/\/[^\s/@:]*:[^\s/@]+@/i,
  /\b(?:postgres(?:ql)?|mysql|mariadb|rediss?|mongodb(?:\+srv)?|mssql|sqlserver|clickhouse|cockroachdb|libsql):\/\//i,
]
const credentialNames = String.raw`(?:(?:x-)?api[-_ ]?(?:key|token)|(?:access|refresh|auth)[-_ ]?token|client[-_ ]?secret|(?:aws[-_ ]?)?secret[-_ ]?(?:access[-_ ]?)?key|(?:pg)?password|passwd|token|secret|authorization|(?:database|db)[-_ ]?url|dsn)`
const credentialKey = new RegExp(`^${credentialNames}$`, 'i')
const credentialAssignment = new RegExp(
  String.raw`(?:^|[^\w-])${credentialNames}["']?\s*[:=]\s*(?:"([^"]*)"|'([^']*)'|((?:(?:basic|bearer)\s+)?[^\s,;"'\x60]+))`,
  'gi',
)
const isRedacted = (value: string) =>
  /^(?:\[redacted\]|<redacted>|\*{3,}|\$(?:[A-Z_][A-Z_0-9]*|\{[A-Z_][A-Z_0-9]*\}))$/i.test(
    value.trim().replace(/^(?:basic|bearer)\s+/i, ''),
  )
const hasCredential = (value: string) =>
  credentialMarkers.some((pattern) => pattern.test(value)) ||
  Array.from(value.matchAll(credentialAssignment)).some(([, double, single, bare]) => {
    const assigned = double ?? single ?? bare?.replace(/[.!?]+$/u, '') ?? ''
    return isText(assigned) && !isRedacted(assigned)
  })
const hasCredentialField = (key: string, value: unknown) =>
  credentialKey.test(key) && value !== null && (typeof value !== 'string' || (isText(value) && !isRedacted(value)))

const displayBundle = (path: string) => {
  const label = path.split(sep).join('/')
  return isInside(path) && /^[\w./-]+$/u.test(label) && !hasCredential(label) ? label : '[redacted bundle path]'
}

const acronymField = 'acronyms'
const ruleField = 'rules'
const analysisFields = ['customAnalyses', 'analyses'] as const
const evidenceFields = new Set(['evidence', 'sources', 'citations', 'provenance', 'verificationNote'])
const fileFields = new Set(['file', 'path', 'filePath', 'sourcePath'])
const displayFields = new Set([
  acronymField,
  ruleField,
  ...analysisFields,
  ...evidenceFields,
  ...fileFields,
  'name',
  'aliases',
  'key',
  'description',
  'searchTerm',
  'sql',
  'sourceCommit',
  'url',
  'referencedTables',
  'version',
  'schemaVersion',
  'dataSource',
  'database',
])

type Field = { value: unknown; path: string; key?: string; citation?: 'rule' | 'evidence' }

function* fields(value: unknown) {
  const pending: Field[] = [{ path: '$', value }]
  while (pending.length) {
    const field = pending.pop()
    if (!field) break
    yield field
    const { value, path, citation } = field
    if (Array.isArray(value)) {
      for (let index = value.length - 1; index >= 0; index--) {
        pending.push({ value: value[index], path: `${path}[${index}]`, citation })
      }
    } else if (isObject(value)) {
      const entries = Object.entries(value)
      for (let index = entries.length - 1; index >= 0; index--) {
        const [key, value] = entries[index]
        pending.push({
          value,
          key,
          path: displayFields.has(key) ? `${path}.${key}` : `${path}{#${index + 1}}`,
          citation: evidenceFields.has(key) ? 'evidence' : (citation ?? (key === ruleField ? 'rule' : undefined)),
        })
      }
    }
  }
}

const blobPath = /^https?:\/\/github\.com\/proompteng\/lab\/blob\/[^/?#]+\/([^?#]+)(?:[?#].*)?$/i
const citationToken = /[^\s`"'()[\]{}<>,;]+/gu
const pathToken = /^(?:[\w.%@+-]+\/)*[\w.%@+-]+$/u
const rootFile = /^(?:Dockerfile|Containerfile|Makefile|LICENSE|README|CODEOWNERS|\.gitignore|\.envrc)$/u
const rootFileExtension = /\.(?:md|mdx|jsonc?|ya?ml|toml|nix|lock|txt|sql|tsx?|jsx?|go|py|sh|rs|mod|sum)$/i
const withoutAnchor = (path: string) => path.replace(/[?#].*$/u, '').replace(/:\d+(?:-\d+)?$/u, '')

function* citations(value: string, evidence: boolean, explicitPath: boolean) {
  const trimmed = value.trim()
  if (explicitPath) {
    // A structured path can be an extensionless root file or contain spaces.
    const blob = blobPath.exec(trimmed)
    if (blob || !/^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed)) {
      yield { target: blob?.[1] ?? withoutAnchor(trimmed), offset: value.indexOf(trimmed) + 1 }
    }
    return
  }
  for (const match of value.matchAll(citationToken)) {
    const token = match[0].replace(/[.!?]+$/u, '')
    const blob = blobPath.exec(token)
    if (blob) {
      yield { target: blob[1], offset: match.index + 1 }
      continue
    }
    const target = withoutAnchor(token)
    if (!pathToken.test(target)) continue
    const name = target.split('/').at(-1) ?? ''
    if (
      rootFile.test(name) ||
      (target.includes('/') ? /\.[a-z][\w-]*$/i.test(name) : rootFileExtension.test(name)) ||
      (evidence && token === trimmed && target.includes('/'))
    ) {
      yield { target, offset: match.index + 1 }
    }
  }
}

const isRepoFile = async (root: string, encodedPath: string) => {
  try {
    const path = decodeURIComponent(encodedPath)
    if (isAbsolute(path)) return false
    const candidate = resolve(root, path)
    if (!isInside(relative(root, candidate))) return false
    const actual = await realpath(candidate)
    return isInside(relative(root, actual)) && (await stat(actual)).isFile()
  } catch {
    return false
  }
}

// After JSON.parse succeeds, the colon following a string can only be a property separator.
// Counting source keys catches values overwritten by duplicate keys, independently of formatting.
const countSourceKeys = (json: string) => {
  let count = 0
  for (const [, colon] of json.matchAll(/"(?:[^"\\]|\\.)*"\s*(:)?/gu)) if (colon) count++
  return count
}

export const auditOntologyBundles = async (root: string, paths?: readonly string[]): Promise<AuditReport> => {
  const directory = resolve(root)
  const checkout = await realpath(directory)
  if (!(await stat(checkout)).isDirectory()) throw new Error('Expected an audit root directory')
  const selected = paths ?? bundleGlob.scanSync({ cwd: checkout, dot: true, onlyFiles: false })
  const files = [...new Set(Array.from(selected, (file) => relative(directory, resolve(directory, file))))].sort()
  const report: AuditReport = { bundles: files.map(displayBundle), findings: [] }
  const terms = new Map<string, Location[]>()

  for (const [bundle, file] of files.entries()) {
    const add = (code: FindingCode, path: string, offset?: number) => {
      report.findings.push({ code, locations: [{ bundle, path, ...(offset === undefined ? {} : { offset }) }] })
    }
    const path = resolve(checkout, file)
    let source: string
    try {
      if (!isInside(file) || (await realpath(path)) !== path || !(await lstat(path)).isFile()) {
        add('bundle-read-error', '$')
        continue
      }
      source = decoder.decode(await readFile(path))
    } catch {
      add('bundle-read-error', '$')
      continue
    }
    let document: unknown
    try {
      document = JSON.parse(source)
    } catch {
      add('invalid-json', '$')
      continue
    }

    // Audit the available fields even if the file has an invalid bundle shape.
    let remainingKeys = countSourceKeys(source)
    for (const { value, key, path, citation } of fields(document)) {
      if (key !== undefined) remainingKeys--
      let secret =
        (key !== undefined && (hasCredential(key) || hasCredentialField(key, value))) ||
        (typeof value === 'string' && hasCredential(value))
      if (key === 'sql') {
        if (!isText(value)) {
          add('invalid-bundle', path)
        } else {
          try {
            await readSelectRelations(value, (text) => {
              secret ||= hasCredential(text)
            })
          } catch {
            add('unsafe-sql', path)
          }
        }
      } else if (citation && isText(value)) {
        const checked = new Set<string>()
        for (const { target, offset } of citations(value, citation === 'evidence', fileFields.has(key ?? ''))) {
          if (checked.has(target)) continue
          checked.add(target)
          if (!(await isRepoFile(checkout, target))) add('citation-drift', path, offset)
        }
      }
      if (secret) add('possible-secret', path)
    }
    if (remainingKeys !== 0) add('invalid-json', '$')

    if (!isObject(document) || (document.version !== 1 && document.schemaVersion !== 'bayn.ontology.knowledge.v1')) {
      add('invalid-bundle', '$')
      continue
    }
    const analysisField =
      document.schemaVersion === 'bayn.ontology.knowledge.v1' ? analysisFields[1] : analysisFields[0]
    for (const key of [acronymField, ruleField, analysisField]) {
      const entries = document[key]
      if (!Array.isArray(entries)) {
        add('invalid-bundle', `$.${key}`)
        continue
      }
      for (const [index, entry] of entries.entries()) {
        const path = `$.${key}[${index}]`
        if (!isObject(entry)) {
          add('invalid-bundle', path)
        } else if (key === analysisField && !Object.hasOwn(entry, 'sql')) {
          add('invalid-bundle', `${path}.sql`)
        } else if (key === acronymField) {
          const register = (term: unknown, path: string) => {
            if (!isText(term)) return add('invalid-bundle', path)
            const normalized = term.trim().toLowerCase()
            const location = { bundle, path }
            const matches = terms.get(normalized)
            if (matches) matches.push(location)
            else terms.set(normalized, [location])
          }
          register(entry.name, `${path}.name`)
          if (entry.aliases === undefined) continue
          if (!Array.isArray(entry.aliases)) add('invalid-bundle', `${path}.aliases`)
          else for (const [alias, term] of entry.aliases.entries()) register(term, `${path}.aliases[${alias}]`)
        }
      }
    }
  }

  for (const locations of terms.values()) {
    if (locations.some(({ bundle }) => bundle !== locations[0].bundle)) {
      report.findings.push({ code: 'acronym-collision', locations })
    }
  }
  return report
}
