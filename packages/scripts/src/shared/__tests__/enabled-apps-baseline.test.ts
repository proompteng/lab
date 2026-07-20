import { expect, it } from 'bun:test'

import { loadEnabledAppInventory } from '../enabled-apps'

it('preserves the established enabled ApplicationSet inventory baseline', () => {
  expect(loadEnabledAppInventory().applicationSetEntryCount).toBeGreaterThanOrEqual(68)
})
