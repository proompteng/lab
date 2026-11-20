import { expect, test } from 'bun:test'
import { resolve } from 'node:path'

import { verifyTemporalRuntime } from '../../scripts/verify-temporal-runtime'

test('production workflow consumer and SDK share Effect 4.1.4', async () => {
  const result = await verifyTemporalRuntime(resolve(import.meta.dir, '../..'))
  expect(result.sdkEffect).toBe('4.1.4')
  expect(result.workflowEffect).toBe('4.1.4')
})
