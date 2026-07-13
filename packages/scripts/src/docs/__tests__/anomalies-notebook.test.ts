import { expect, it } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { repoRoot } from '../../shared/cli'

it('keeps anomaly scores aligned with the original feature rows during PCA projection', () => {
  const notebook = JSON.parse(readFileSync(join(repoRoot, 'books/anomalies/anomalies.ipynb'), 'utf8')) as {
    cells?: Array<{ source?: string[] }>
  }
  const source = notebook.cells?.flatMap((cell) => cell.source ?? []).join('') ?? ''

  expect(source).toContain('const rankedRows = [...scoredRows].sort((a, b) => b.score - a.score);')
  expect(source).toContain('state.qboScores = { rows: rankedRows, featureNames };')
  expect(source).toContain('score: scoredRows[index].score,')
  expect(source).toContain('const precision = rankedRows')
  expect(source).not.toContain('scoredRows.sort((a, b) => b.score - a.score);')
})
