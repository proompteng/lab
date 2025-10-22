import { access, appendFile, constants, readFile } from 'node:fs/promises'
import process from 'node:process'

const summaryPath = process.env.COVERAGE_SUMMARY_PATH ?? 'apps/froussard/coverage/coverage-summary.json'

const formatPercent = (value) => (Number.isFinite(value) ? `${value.toFixed(2)}%` : 'n/a')

const ensureTotals = (coverage) => {
  if (!coverage) {
    throw new Error(`Coverage summary missing totals at ${summaryPath}`)
  }
  const keys = ['lines', 'statements', 'functions', 'branches']
  for (const key of keys) {
    if (!coverage[key]) {
      throw new Error(`Coverage summary missing key '${key}' at ${summaryPath}`)
    }
  }
  return {
    lines: coverage.lines.pct ?? coverage.lines.percent,
    statements: coverage.statements.pct ?? coverage.statements.percent,
    functions: coverage.functions.pct ?? coverage.functions.percent,
    branches: coverage.branches.pct ?? coverage.branches.percent,
  }
}

const main = async () => {
  try {
    await access(summaryPath, constants.R_OK)
  } catch {
    console.warn(`Coverage summary not found at ${summaryPath}; skipping report.`)
    return
  }

  const raw = await readFile(summaryPath, 'utf8')
  const data = JSON.parse(raw)
  const totals = ensureTotals(data.total ?? data.totals)

  const table = [
    '| Metric | Percentage |',
    '| --- | --- |',
    `| Statements | ${formatPercent(totals.statements)} |`,
    `| Branches | ${formatPercent(totals.branches)} |`,
    `| Functions | ${formatPercent(totals.functions)} |`,
    `| Lines | ${formatPercent(totals.lines)} |`,
  ].join('\n')

  // print for logs
  console.log('\nFroussard coverage summary:\n')
  console.log(table)

  if (process.env.GITHUB_STEP_SUMMARY) {
    await appendFile(process.env.GITHUB_STEP_SUMMARY, `## Froussard Coverage\n\n${table}\n\n`, 'utf8')
  }
}

main().catch((error) => {
  console.error('Failed to report coverage summary', error)
  process.exitCode = 1
})
