import { describe, expect, test } from 'vitest'

import { imageModalCaptionId, imageModalTitleId, initialImageModalState, reduceImageModalState } from './image-modal'

describe('attachment image modal behavior', () => {
  test('opens images and closes via button/backdrop action', () => {
    const open = reduceImageModalState(initialImageModalState, { type: 'open', imageId: 'asset-1' })

    expect(open).toEqual({ isOpen: true, imageId: 'asset-1' })
    expect(reduceImageModalState(open, { type: 'close' })).toEqual(initialImageModalState)
  })

  test('closes on Escape and ignores unrelated keys', () => {
    const open = { isOpen: true, imageId: 'asset-1' }

    expect(reduceImageModalState(open, { type: 'escape', key: 'Tab' })).toBe(open)
    expect(reduceImageModalState(open, { type: 'escape', key: 'Escape' })).toEqual(initialImageModalState)
  })

  test('uses stable accessible ids for title and caption context', () => {
    expect(imageModalTitleId('asset-1')).toBe('attachment-image-modal-title-asset-1')
    expect(imageModalCaptionId('asset-1')).toBe('attachment-image-modal-caption-asset-1')
  })
})
