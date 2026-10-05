import { expect, test } from 'bun:test'
import { resolve } from 'node:path'

import { verifyTemporalRuntime } from '../../scripts/verify-temporal-runtime'

test('production workflow consumer uses the published Effect 3 runtime', async () => {
  const result = await verifyTemporalRuntime(resolve(import.meta.dir, '../..'))
  expect(result.sdk).toBe('0.11.5')
  expect(result.sdkEffect).toBe('3.22.1')
  expect(result.workflowEffect).toBe('3.22.1')
  expect(result.entry).toContain('/node_modules/')
})
