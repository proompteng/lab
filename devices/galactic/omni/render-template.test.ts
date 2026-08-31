import { readFileSync } from 'node:fs'

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

  test('pulls Firecracker images into blockfile on every machine', () => {
    const clusterTemplate = readFileSync(new URL('./cluster-template.yaml', import.meta.url), 'utf8')

    expect(
      clusterTemplate.match(
        /\[plugins\."io\.containerd\.cri\.v1\.images"\.runtime_platforms\.kata-fc\]\n\s+snapshotter = "blockfile"/g,
      ),
    ).toHaveLength(3)
    expect(clusterTemplate.match(/RuntimeClassInImageCriApi: true/g)).toHaveLength(3)
  })

  test('pins Altra installation to its stable system-disk identity', () => {
    const clusterTemplate = readFileSync(new URL('./cluster-template.yaml', import.meta.url), 'utf8')

    expect(clusterTemplate).toContain('disk: "/dev/disk/by-id/nvme-CT4000P3PSSD8_2441E98EAAFB"\n          wipe: false')
  })
})
