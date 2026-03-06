// @vitest-environment jsdom
import { render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

import { TorghutVisualsControls } from '@/components/torghut-visuals-controls'

describe('TorghutVisualsControls', () => {
  it('uses themed select triggers instead of native select elements', () => {
    const { container } = render(
      <TorghutVisualsControls
        symbols={['AAPL', 'MSFT']}
        selectedSymbol="MSFT"
        onSymbolChange={vi.fn()}
        rangeOptions={[
          { id: '15m', label: 'Last 15m', seconds: 900 },
          { id: '1h', label: 'Last 1h', seconds: 3600 },
        ]}
        range={{ id: '1h', label: 'Last 1h', seconds: 3600 }}
        onRangeChange={vi.fn()}
        resolutionOptions={[
          { id: '15s', label: '15s', seconds: 15 },
          { id: '1m', label: '1m', seconds: 60 },
        ]}
        resolution={{ id: '15s', label: '15s', seconds: 15 }}
        onResolutionChange={vi.fn()}
        indicators={{ ema: true, boll: true, vwap: false, macd: false, rsi: false }}
        onIndicatorToggle={vi.fn()}
        onRefresh={vi.fn()}
        isRefreshing={false}
        queryLimit={240}
        maxPoints={2000}
      />,
    )

    expect(container.querySelectorAll('select')).toHaveLength(0)
    expect(screen.getAllByRole('combobox')).toHaveLength(3)
    expect(screen.getByText('MSFT')).toBeTruthy()
    expect(screen.getByText('1h')).toBeTruthy()
    expect(screen.getByText('15s')).toBeTruthy()
  })
})
