import { expect, it } from 'bun:test'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

import { repoRoot } from '../../shared/cli'

const notebookPath = join(repoRoot, 'books/anomalies/anomalies.ipynb')

const readNotebookSource = (): string => {
  const notebook = JSON.parse(readFileSync(notebookPath, 'utf8')) as {
    cells?: Array<{ source?: string[] }>
  }
  return notebook.cells?.flatMap((cell) => cell.source ?? []).join('') ?? ''
}

it('keeps anomaly scores aligned with the original feature rows during PCA projection', () => {
  const source = readNotebookSource()

  expect(source).toContain('const rankedRows = [...scoredRows].sort((a, b) => b.score - a.score);')
  expect(source).toContain('state.qboScores = { rows: rankedRows, featureNames };')
  expect(source).toContain('score: scoredRows[index].score,')
  expect(source).toContain('const precision = rankedRows')
  expect(source).not.toContain('scoredRows.sort((a, b) => b.score - a.score);')
})

it('keeps Deno dependency state scoped to the anomaly notebook', () => {
  const config = JSON.parse(readFileSync(join(repoRoot, 'books/anomalies/deno.json'), 'utf8')) as {
    lock?: unknown
  }
  const source = readNotebookSource()

  expect(config.lock).toBe(false)
  expect(existsSync(join(repoRoot, 'deno.lock'))).toBe(false)
  expect(existsSync(join(repoRoot, 'books/anomalies/deno.lock'))).toBe(false)
  expect(source).toContain('https://cdn.jsdelivr.net/npm/d3@7.9.0/+esm')
  expect(source).not.toContain('https://cdn.jsdelivr.net/npm/d3@7/+esm')
})
