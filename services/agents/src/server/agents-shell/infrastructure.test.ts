import { describe, expect, it } from 'vitest'

import { type InspectionCommand, requireInfrastructureInspectionArgs } from './tools/infrastructure'

describe('infrastructure inspection boundary', () => {
  it.each<[InspectionCommand, string[]]>([
    ['talosctl', ['get', 'pcidevices', '0000:00:01.0', '--nodes', 'machine-uuid', '-o', 'json']],
    ['talosctl', ['dmesg', '--nodes=machine-uuid']],
    ['talosctl', ['version', '--client']],
    ['omnictl', ['get', 'machinestatus', '--selector=omni.sidero.dev/cluster=galactic', '-o', 'json']],
    ['omnictl', ['--version']],
  ])('allows %s inspection without an alternate identity', (command, args) => {
    expect(() => requireInfrastructureInspectionArgs(command, args)).not.toThrow()
  })

  it.each<[InspectionCommand, string[]]>([
    ['talosctl', ['reboot', '--nodes', 'machine-uuid']],
    ['talosctl', ['service', 'apid', 'restart']],
    ['talosctl', ['read', '/system/state/config.yaml']],
    ['talosctl', ['get', 'pcidevices', '--talosconfig=/workspace/admin']],
    ['talosctl', ['get', 'pcidevices', '-e', 'other-node']],
    ['talosctl', ['version', '--insecure']],
    ['omnictl', ['apply', '-f', 'patch.yaml']],
    ['omnictl', ['serviceaccount', 'create', 'operator']],
    ['omnictl', ['get', 'clusters', '--omniconfig', '/workspace/admin']],
    ['omnictl', ['get', 'clusters', '--insecure-skip-tls-verify']],
    ['omnictl', ['get', 'clusters', '--output']],
    ['omnictl', ['get', 'clusters', '--selector=']],
    ['talosctl', ['--nodes', 'machine-uuid', 'reboot']],
  ])('rejects %s mutation, identity override or malformed options', (command, args) => {
    expect(() => requireInfrastructureInspectionArgs(command, args)).toThrow()
  })
})
