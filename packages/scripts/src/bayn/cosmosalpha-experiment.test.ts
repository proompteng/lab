import { expect, test } from 'bun:test'
import { join } from 'node:path'

test('frozen CosmosAlpha experiment budgets, transport and replay protection', () => {
  const child = Bun.spawnSync(['python3', join(import.meta.dir, 'test_cosmosalpha_experiment.py')])
  expect(child.stderr.toString()).toContain('OK')
  expect(child.exitCode).toBe(0)
})
