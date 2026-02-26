// @vitest-environment jsdom
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { WhitepaperSemanticSearchRoute } from './search'

const whitepaperSearchMocks = vi.hoisted(() => ({
  searchWhitepapersSemantic: vi.fn(),
}))

vi.mock('@/data/whitepapers', async () => {
  const actual = await vi.importActual<typeof import('@/data/whitepapers')>('@/data/whitepapers')
  return {
    ...actual,
    searchWhitepapersSemantic: whitepaperSearchMocks.searchWhitepapersSemantic,
  }
})

describe('WhitepaperSemanticSearchRoute', () => {
  beforeEach(() => {
    whitepaperSearchMocks.searchWhitepapersSemantic.mockReset()
  })

  it('clears loading state when semantic search throws', async () => {
    whitepaperSearchMocks.searchWhitepapersSemantic.mockRejectedValueOnce(new Error('semantic backend unavailable'))
    render(<WhitepaperSemanticSearchRoute />)

    fireEvent.change(screen.getByPlaceholderText('Find ideas, methods, or claims'), {
      target: { value: 'alpha factors' },
    })
    fireEvent.click(screen.getByRole('button', { name: 'Search' }))

    await waitFor(() => {
      expect(whitepaperSearchMocks.searchWhitepapersSemantic).toHaveBeenCalledTimes(1)
    })

    await screen.findByText('Semantic search failed')
    expect(screen.getByText('semantic backend unavailable')).toBeTruthy()
    await waitFor(() => {
      expect(screen.queryByText('Searching…')).toBeNull()
    })
  })
})
