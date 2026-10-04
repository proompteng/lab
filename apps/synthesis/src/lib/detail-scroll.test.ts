import { describe, expect, test } from 'vitest'

import { resetDetailScrollToTop } from './detail-scroll'

describe('detail sidebar scroll reset', () => {
  test('resets only the detail scroll container to the top', () => {
    const detailScrollContainer = { scrollTop: 540 }
    const feedScrollContainer = { scrollTop: 320 }

    resetDetailScrollToTop(detailScrollContainer)

    expect(detailScrollContainer.scrollTop).toBe(0)
    expect(feedScrollContainer.scrollTop).toBe(320)
  })

  test('allows the detail sidebar to be absent on small viewports', () => {
    expect(() => resetDetailScrollToTop(null)).not.toThrow()
  })
})
