// @vitest-environment jsdom
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import type { ReactNode } from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { WhitepaperSemanticSearchRoute } from './search'

vi.mock('@proompteng/design/ui', async () => {
  const React = await import('react')
  type MockProps = Record<string, unknown> & { children?: ReactNode }

  const block =
    (tag: string) =>
    ({ children, ...props }: MockProps) =>
      React.createElement(tag, props, children)

  return {
    Badge: block('span'),
    Button: ({ children, asChild: _asChild, variant: _variant, size: _size, ...props }: MockProps) =>
      React.createElement('button', props, children),
    Card: block('section'),
    CardContent: block('div'),
    CardDescription: block('p'),
    CardHeader: block('header'),
    CardTitle: block('h2'),
    Input: (props: MockProps) => React.createElement('input', props),
    Select: ({ children }: MockProps) => React.createElement('div', null, children),
    SelectContent: ({ children, align: _align, ...props }: MockProps) => React.createElement('div', props, children),
    SelectItem: ({ children, value: _value, ...props }: MockProps) => React.createElement('div', props, children),
    SelectTrigger: ({ children, ...props }: MockProps) =>
      React.createElement('button', { ...props, role: 'combobox', type: 'button' }, children),
    SelectValue: ({ placeholder }: { placeholder?: string }) => React.createElement('span', null, placeholder ?? null),
    Skeleton: block('div'),
  }
})

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
