import { describe, expect, test } from 'bun:test'

import { extractSecrets, renderTemplate } from './render-template'

const template = `
TS_AUTHKEY=__GALACTIC_TAILSCALE_AUTH_KEY__
jointoken=__GALACTIC_OMNI_JOIN_TOKEN__
TS_AUTHKEY=__GALACTIC_TAILSCALE_AUTH_KEY__
jointoken=__GALACTIC_OMNI_JOIN_TOKEN__
TS_AUTHKEY=__GALACTIC_TAILSCALE_AUTH_KEY__
jointoken=__GALACTIC_OMNI_JOIN_TOKEN__
`

describe('Omni cluster template secret rendering', () => {
  test('extracts one shared credential of each type from a live export', () => {
    const raw = `TS_AUTHKEY=tskey-test\njointoken=join-test\nTS_AUTHKEY=tskey-test\njointoken=join-test`

    expect(extractSecrets(raw)).toEqual({
      tailscaleAuthKey: 'tskey-test',
      omniJoinToken: 'join-test',
    })
  })

  test('rejects inconsistent credentials across machines', () => {
    expect(() => extractSecrets('TS_AUTHKEY=one\nTS_AUTHKEY=two\njointoken=join')).toThrow(
      'expected exactly one unique Tailscale auth key',
    )
  })

  test('renders every machine without leaving placeholders', () => {
    const rendered = renderTemplate(template, {
      tailscaleAuthKey: 'tskey-test',
      omniJoinToken: 'join-test',
    })

    expect(rendered).not.toContain('__GALACTIC_')
    expect(rendered.match(/TS_AUTHKEY=tskey-test/g)).toHaveLength(3)
    expect(rendered.match(/jointoken=join-test/g)).toHaveLength(3)
  })
})
