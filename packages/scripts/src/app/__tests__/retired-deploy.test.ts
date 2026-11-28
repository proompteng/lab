import { expect, test } from 'bun:test'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

import { repoRoot } from '../../shared/cli'

test('does not register or ship the retired App deploy command', () => {
  const manifest = JSON.parse(readFileSync(join(repoRoot, 'package.json'), 'utf8'))

  expect(manifest.scripts).not.toHaveProperty('app:deploy')
  expect(existsSync(join(repoRoot, 'packages/scripts/src/app/deploy-service.ts'))).toBe(false)
})
