import { describe, expect, it } from 'bun:test'

import { __private } from '../check-automation-policy'

describe('check-automation-policy', () => {
  it('parses automation modes for app entries', () => {
    const source = `elements:
  - name: jangar
    path: argocd/applications/jangar
    automation: auto
  - name: bumba
    path: argocd/applications/bumba
    automation: manual
`

    const parsed = __private.parseAutomationModes(source)
    expect(parsed.get('jangar')).toBe('auto')
    expect(parsed.get('bumba')).toBe('manual')
  })

  it('parses repeated require flags', () => {
    const parsed = __private.parseArgs(['--require', 'jangar=auto', '--require', 'bumba=manual'])
    expect(parsed.requirements).toEqual([
      { app: 'jangar', mode: 'auto' },
      { app: 'bumba', mode: 'manual' },
    ])
  })
})
