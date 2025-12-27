#!/usr/bin/env bun

import { ensureCli, fatal } from '../shared/cli'

type Options = {
  namespace: string
  cluster: string
  database: string
  sinceHours: number
  limit: number
  repository?: string
  workflowId?: string
  commit?: string
}

const DEFAULT_NAMESPACE = process.env.JANGAR_DB_NAMESPACE ?? 'jangar'
const DEFAULT_CLUSTER = process.env.JANGAR_DB_CLUSTER ?? 'jangar-db'
const DEFAULT_DATABASE = process.env.JANGAR_DB_NAME ?? 'jangar'
const DEFAULT_SINCE_HOURS = Number.parseInt(process.env.JANGAR_DB_SINCE_HOURS ?? '24', 10)
const DEFAULT_LIMIT = Number.parseInt(process.env.JANGAR_DB_LIMIT ?? '5', 10)

const usage = () =>
  `
Usage:
  bun run packages/scripts/src/bumba/check-jangar-db.ts [options]

Options:
  --namespace <name>       Kubernetes namespace (default: ${DEFAULT_NAMESPACE})
  --cluster <name>         CNPG cluster name (default: ${DEFAULT_CLUSTER})
  --database <name>        Database name (default: ${DEFAULT_DATABASE})
  --since-hours <hours>    Lookback window for recent ingest summaries (default: ${DEFAULT_SINCE_HOURS})
  --limit <count>          Number of rows to show in recent lists (default: ${DEFAULT_LIMIT})
  --repository <slug>      Filter to a repository slug (e.g. proompteng/lab)
  --workflow-id <id>       Inspect a specific workflow id for deep checks
  --commit <sha>           Filter by repository commit when workflow id is missing
  -h, --help               Show this help message

Environment:
  JANGAR_DB_NAMESPACE, JANGAR_DB_CLUSTER, JANGAR_DB_NAME, JANGAR_DB_SINCE_HOURS, JANGAR_DB_LIMIT

Examples:
  bun run packages/scripts/src/bumba/check-jangar-db.ts
  bun run packages/scripts/src/bumba/check-jangar-db.ts --repository proompteng/lab --since-hours 6
  bun run packages/scripts/src/bumba/check-jangar-db.ts --workflow-id bumba-repo-<id>
  bun run packages/scripts/src/bumba/check-jangar-db.ts --commit <sha>
`.trim()

const readValue = (arg: string, argv: string[], index: number) => {
  const value = argv[index + 1]
  if (!value || value.startsWith('-')) {
    fatal(`${arg} requires a value`)
  }
  return value
}

const parseArgs = (argv: string[]): Options => {
  const options: Options = {
    namespace: DEFAULT_NAMESPACE,
    cluster: DEFAULT_CLUSTER,
    database: DEFAULT_DATABASE,
    sinceHours: Number.isFinite(DEFAULT_SINCE_HOURS) ? DEFAULT_SINCE_HOURS : 24,
    limit: Number.isFinite(DEFAULT_LIMIT) ? DEFAULT_LIMIT : 5,
  }

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    if (!arg) continue

    if (arg === '--help' || arg === '-h') {
      console.log(usage())
      process.exit(0)
    }

    if (arg === '--namespace') {
      options.namespace = readValue(arg, argv, i)
      i += 1
      continue
    }

    if (arg.startsWith('--namespace=')) {
      options.namespace = arg.slice('--namespace='.length)
      continue
    }

    if (arg === '--cluster') {
      options.cluster = readValue(arg, argv, i)
      i += 1
      continue
    }

    if (arg.startsWith('--cluster=')) {
      options.cluster = arg.slice('--cluster='.length)
      continue
    }

    if (arg === '--database') {
      options.database = readValue(arg, argv, i)
      i += 1
      continue
    }

    if (arg.startsWith('--database=')) {
      options.database = arg.slice('--database='.length)
      continue
    }

    if (arg === '--since-hours') {
      options.sinceHours = Number.parseFloat(readValue(arg, argv, i))
      i += 1
      continue
    }

    if (arg.startsWith('--since-hours=')) {
      options.sinceHours = Number.parseFloat(arg.slice('--since-hours='.length))
      continue
    }

    if (arg === '--limit') {
      options.limit = Number.parseInt(readValue(arg, argv, i), 10)
      i += 1
      continue
    }

    if (arg.startsWith('--limit=')) {
      options.limit = Number.parseInt(arg.slice('--limit='.length), 10)
      continue
    }

    if (arg === '--repository') {
      options.repository = readValue(arg, argv, i)
      i += 1
      continue
    }

    if (arg.startsWith('--repository=')) {
      options.repository = arg.slice('--repository='.length)
      continue
    }

    if (arg === '--workflow-id') {
      options.workflowId = readValue(arg, argv, i)
      i += 1
      continue
    }

    if (arg.startsWith('--workflow-id=')) {
      options.workflowId = arg.slice('--workflow-id='.length)
      continue
    }

    if (arg === '--commit') {
      options.commit = readValue(arg, argv, i)
      i += 1
      continue
    }

    if (arg.startsWith('--commit=')) {
      options.commit = arg.slice('--commit='.length)
      continue
    }

    fatal(`Unknown option: ${arg}`)
  }

  if (!Number.isFinite(options.sinceHours) || options.sinceHours <= 0) {
    fatal('--since-hours must be a positive number')
  }

  if (!Number.isFinite(options.limit) || options.limit <= 0) {
    fatal('--limit must be a positive number')
  }

  return options
}

const sqlLiteral = (value: string) => `'${value.replace(/'/g, "''")}'`

const extractCommitFromWorkflowId = (workflowId?: string) => {
  if (!workflowId) return undefined
  const match = workflowId.match(/bumba-repo-([a-f0-9]{40})/i)
  if (match?.[1]) return match[1]
  if (/^[a-f0-9]{40}$/i.test(workflowId)) return workflowId
  return undefined
}

const capture = async (command: string, args: string[]) => {
  const subprocess = Bun.spawn([command, ...args], {
    stdout: 'pipe',
    stderr: 'pipe',
  })

  const stdout = subprocess.stdout ? await new Response(subprocess.stdout).text() : ''
  const stderr = subprocess.stderr ? await new Response(subprocess.stderr).text() : ''
  const exitCode = await subprocess.exited

  if (exitCode !== 0) {
    console.error(stderr.trim() || `Command ${command} ${args.join(' ')} failed`)
    fatal(`Command failed (${exitCode}): ${command} ${args.join(' ')}`)
  }

  if (stderr.trim()) {
    console.warn(stderr.trim())
  }

  return stdout
}

const query = async (options: Options, sql: string) => {
  const args = [
    'cnpg',
    'psql',
    options.cluster,
    '-n',
    options.namespace,
    '--',
    '-d',
    options.database,
    '-v',
    'ON_ERROR_STOP=1',
    '-A',
    '-F',
    '\t',
    '-t',
    '-c',
    sql,
  ]

  const output = await capture('kubectl', args)
  return output.trim()
}

const queryRows = async (options: Options, sql: string) => {
  const output = await query(options, sql)
  if (!output) {
    return [] as string[][]
  }
  return output
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => line.split('\t'))
}

const printSection = (title: string) => {
  console.log(`\n${title}`)
  console.log('='.repeat(title.length))
}

const printTable = (rows: string[][], headers: string[]) => {
  if (rows.length === 0) {
    console.log('  (none)')
    return
  }
  const widths = headers.map((header, index) =>
    Math.max(header.length, ...rows.map((row) => (row[index] ?? '').length)),
  )
  const formatRow = (row: string[]) => row.map((value, index) => (value ?? '').padEnd(widths[index])).join('  ')
  console.log(`  ${formatRow(headers)}`)
  console.log(`  ${widths.map((width) => '-'.repeat(width)).join('  ')}`)
  for (const row of rows) {
    console.log(`  ${formatRow(row)}`)
  }
}

const pickLatestIngestion = async (options: Options) => {
  const repoJoin = options.repository ? 'JOIN atlas.github_events ge ON ge.id = i.event_id' : ''
  const repoFilter = options.repository ? `AND ge.repository = ${sqlLiteral(options.repository)}` : ''
  const workflowFilter = options.workflowId ? `AND i.workflow_id = ${sqlLiteral(options.workflowId)}` : ''
  const rows = await queryRows(
    options,
    `
    SELECT i.id, i.workflow_id, i.status, i.started_at, i.finished_at, COALESCE(i.error, '')
    FROM atlas.ingestions i
    ${repoJoin}
    WHERE 1=1
      ${repoFilter}
      ${workflowFilter}
    ORDER BY i.started_at DESC
    LIMIT 1;
    `.trim(),
  )

  if (rows.length === 0) {
    return null
  }

  const [id, workflowId, status, startedAt, finishedAt, error] = rows[0]
  return { id, workflowId, status, startedAt, finishedAt, error }
}

const pickLatestIngestionByCommit = async (options: Options, commit: string) => {
  const repoJoin = options.repository ? 'JOIN atlas.repositories r ON r.id = fk.repository_id' : ''
  const repoFilter = options.repository ? `AND r.name = ${sqlLiteral(options.repository)}` : ''
  const rows = await queryRows(
    options,
    `
    WITH targets AS (
      SELECT it.ingestion_id, COUNT(*) AS target_count
      FROM atlas.ingestion_targets it
      JOIN atlas.file_versions fv ON fv.id = it.file_version_id
      JOIN atlas.file_keys fk ON fk.id = fv.file_key_id
      ${repoJoin}
      WHERE fv.repository_commit = ${sqlLiteral(commit)}
        ${repoFilter}
      GROUP BY it.ingestion_id
    )
    SELECT i.id, i.workflow_id, i.status, i.started_at, i.finished_at, COALESCE(i.error, ''), ge.repository, t.target_count
    FROM targets t
    JOIN atlas.ingestions i ON i.id = t.ingestion_id
    JOIN atlas.github_events ge ON ge.id = i.event_id
    ORDER BY i.started_at DESC
    LIMIT 1;
    `.trim(),
  )

  if (rows.length === 0) {
    return null
  }

  const [id, workflowId, status, startedAt, finishedAt, error, repository, targetCount] = rows[0]
  return { id, workflowId, status, startedAt, finishedAt, error, repository, targetCount }
}

const main = async () => {
  const options = parseArgs(Bun.argv.slice(2))
  ensureCli('kubectl')

  try {
    await query(options, 'SELECT 1;')
  } catch (error) {
    fatal(
      'Failed to run kubectl cnpg psql. Ensure the cnpg plugin is installed and cluster access is configured.',
      error,
    )
  }

  printSection('Atlas Summary')
  const counts = await queryRows(
    options,
    `
    SELECT
      (SELECT COUNT(*) FROM atlas.repositories),
      (SELECT COUNT(*) FROM atlas.file_keys),
      (SELECT COUNT(*) FROM atlas.file_versions),
      (SELECT COUNT(*) FROM atlas.enrichments),
      (SELECT COUNT(*) FROM atlas.embeddings),
      (SELECT COUNT(*) FROM atlas.ingestions);
    `.trim(),
  )

  if (counts[0]) {
    const [repositories, fileKeys, fileVersions, enrichments, embeddings, ingestions] = counts[0]
    console.log(`  repositories: ${repositories}`)
    console.log(`  file_keys:     ${fileKeys}`)
    console.log(`  file_versions: ${fileVersions}`)
    console.log(`  enrichments:   ${enrichments}`)
    console.log(`  embeddings:    ${embeddings}`)
    console.log(`  ingestions:    ${ingestions}`)
  }

  printSection(`Ingestions in last ${options.sinceHours}h`)
  const statusRows = await queryRows(
    options,
    `
    SELECT status, COUNT(*)
    FROM atlas.ingestions
    WHERE started_at >= NOW() - INTERVAL '${options.sinceHours} hours'
    GROUP BY status
    ORDER BY status;
    `.trim(),
  )
  printTable(statusRows, ['status', 'count'])

  const repoJoin = options.repository ? 'JOIN atlas.github_events ge ON ge.id = i.event_id' : ''
  const repoFilter = options.repository ? `AND ge.repository = ${sqlLiteral(options.repository)}` : ''
  const recentRows = await queryRows(
    options,
    `
    SELECT i.workflow_id, i.status, i.started_at, i.finished_at
    FROM atlas.ingestions i
    ${repoJoin}
    WHERE i.started_at >= NOW() - INTERVAL '${options.sinceHours} hours'
      ${repoFilter}
    ORDER BY i.started_at DESC
    LIMIT ${options.limit};
    `.trim(),
  )
  printTable(recentRows, ['workflow_id', 'status', 'started_at', 'finished_at'])

  printSection('Latest ingestion detail')
  let latest = await pickLatestIngestion(options)
  if (!latest) {
    const commit = options.commit ?? extractCommitFromWorkflowId(options.workflowId)
    if (commit) {
      const fallback = await pickLatestIngestionByCommit(options, commit)
      if (fallback) {
        console.log('  No ingestion rows matched workflow id; using commit-based match.')
        console.log(`  commit:      ${commit}`)
        if (fallback.repository) {
          console.log(`  repository:  ${fallback.repository}`)
        }
        if (fallback.targetCount) {
          console.log(`  targets:     ${fallback.targetCount}`)
        }
        latest = fallback
      } else {
        console.log('  No ingestion rows found with the provided filters.')
        console.log(`  commit fallback attempted: ${commit}`)
        return
      }
    } else {
      console.log('  No ingestion rows found with the provided filters.')
      return
    }
  }

  console.log(`  workflow_id: ${latest.workflowId}`)
  console.log(`  status:      ${latest.status}`)
  console.log(`  started_at:  ${latest.startedAt}`)
  console.log(`  finished_at: ${latest.finishedAt || '(null)'}`)
  if (latest.error) {
    console.log(`  error:       ${latest.error}`)
  }

  printSection('Quality checks (latest ingestion)')
  const qualityRows = await queryRows(
    options,
    `
    WITH target_versions AS (
      SELECT it.file_version_id
      FROM atlas.ingestion_targets it
      WHERE it.ingestion_id = ${sqlLiteral(latest.id)}
    ),
    enrichments AS (
      SELECT e.id, e.file_version_id
      FROM atlas.enrichments e
      WHERE e.file_version_id IN (SELECT file_version_id FROM target_versions)
    )
    SELECT
      (SELECT COUNT(*) FROM target_versions) AS targets,
      (SELECT COUNT(DISTINCT file_version_id) FROM target_versions) AS distinct_files,
      (SELECT COUNT(*) FROM target_versions tv
        LEFT JOIN enrichments e ON e.file_version_id = tv.file_version_id
        WHERE e.id IS NULL) AS missing_enrichments,
      (SELECT COUNT(*) FROM enrichments e
        LEFT JOIN atlas.embeddings em ON em.enrichment_id = e.id
        WHERE em.id IS NULL) AS missing_embeddings,
      (SELECT COUNT(*) FROM target_versions tv
        LEFT JOIN atlas.tree_sitter_facts ts ON ts.file_version_id = tv.file_version_id
        WHERE ts.id IS NULL) AS missing_tree_sitter_facts;
    `.trim(),
  )

  if (!qualityRows[0]) {
    console.log('  No ingestion targets found for latest ingestion.')
    return
  }

  const [targets, distinctFiles, missingEnrichments, missingEmbeddings, missingFacts] = qualityRows[0].map((value) =>
    Number.parseInt(value, 10),
  )

  console.log(`  targets:                 ${targets}`)
  console.log(`  distinct file_versions:  ${distinctFiles}`)
  console.log(`  missing enrichments:     ${missingEnrichments}`)
  console.log(`  missing embeddings:      ${missingEmbeddings}`)
  console.log(`  missing tree-sitter:     ${missingFacts}`)

  const findings: string[] = []
  if (targets === 0) {
    findings.push('CRITICAL: latest ingestion has zero ingestion_targets')
  }
  if (missingEnrichments > 0) {
    findings.push(`CRITICAL: ${missingEnrichments} file_versions lack enrichments`)
  }
  if (missingEmbeddings > 0) {
    findings.push(`WARN: ${missingEmbeddings} enrichments lack embeddings`)
  }
  if (missingFacts > 0) {
    findings.push(`WARN: ${missingFacts} file_versions missing tree-sitter facts`)
  }

  if (latest.status !== 'completed') {
    findings.push(`WARN: latest ingestion status is ${latest.status}`)
  }

  printSection('Findings')
  if (findings.length === 0) {
    console.log('  No critical findings detected for latest ingestion.')
  } else {
    for (const finding of findings) {
      console.log(`  ${finding}`)
    }
  }
}

main().catch((error) => fatal('Unexpected failure running Jangar DB checks', error))
