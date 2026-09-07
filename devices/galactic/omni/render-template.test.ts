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

  test.each([
    { machine: '12345678-9abc-deff-1234-56789abcdeff', serial: '2441E98EAAFB', option: 'wipe: false' },
    { machine: '8bf7ec00-171c-11f1-8000-7cc255f16774', serial: '13CBMEK6HEW8CN2X9AKW', option: 'wipe: false' },
    { machine: 'ff115a00-c307-11f0-a28f-648eab3e4100', serial: '50026B73844BB6D7', option: 'grubUseUKICmdline: false' },
  ])('pins $machine to its stable system disk and preserves install options', ({ machine, serial, option }) => {
    const clusterTemplate = readFileSync(new URL('./cluster-template.yaml', import.meta.url), 'utf8')
    const machineDocument = clusterTemplate
      .split('\n---\n')
      .find((document) => document.startsWith(`kind: Machine\nname: ${machine}\n`))

    expect(machineDocument).toContain(`install:\n  diskSelector: disk.serial == "${serial}"`)
    expect(machineDocument).toContain(`install:\n          ${option}`)
    expect(machineDocument).not.toMatch(/\n\s+disk: /)
  })

  test('allows 500 pods after Turin receives its /23 PodCIDR', () => {
    const clusterTemplate = readFileSync(new URL('./cluster-template.yaml', import.meta.url), 'utf8')
    const turinMachine = clusterTemplate.split('\n---\n').find((document) => document.includes('TS_HOSTNAME=turin'))

    expect(turinMachine).toContain('maxPods: 500')
    expect(turinMachine).not.toContain('maxPods: 250')
    expect(clusterTemplate).not.toContain('maxPods: 250')
  })

  test('allows 500 pods after Altra receives its /23 PodCIDR and retains the allocation mask', () => {
    const clusterTemplate = readFileSync(new URL('./cluster-template.yaml', import.meta.url), 'utf8')
    const documents = clusterTemplate.split('\n---\n')
    const altraMachine = documents.find((document) =>
      document.startsWith('kind: Machine\nname: 12345678-9abc-deff-1234-56789abcdeff'),
    )

    expect(altraMachine).toContain('maxPods: 500')
    expect(altraMachine).not.toContain('maxPods: 250')
    expect(documents[0]).toContain('node-cidr-mask-size: "23"')
    expect(clusterTemplate).not.toContain('node-cidr-mask-size-ipv4')
  })
})
