import { describe, expect, test } from 'vitest'

import {
  synthesisHasBottomLeftCounter,
  synthesisHasCurateAction,
  synthesisSearchInputClassName,
  synthesisSidebarItems,
} from './synthesis-ui-contract'

describe('synthesis shell polish contract', () => {
  test('removes legacy navigation/actions and makes search full width', () => {
    expect(synthesisSidebarItems).toEqual(['Feed'])
    expect(synthesisSidebarItems).not.toContain('Search')
    expect(synthesisHasCurateAction).toBe(false)
    expect(synthesisHasBottomLeftCounter).toBe(false)
    expect(synthesisSearchInputClassName.split(/\s+/)).toContain('w-full')
  })
})
