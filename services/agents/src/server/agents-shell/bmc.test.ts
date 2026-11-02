import * as Schema from 'effect/Schema'
import { describe, expect, it } from 'vitest'

import { BmcInputSchema, buildBmcInspection } from './tools/bmc'

describe('BMC inspection boundary', () => {
  it.each(['altra', 'turin'])('uses a fixed target and encrypted USER session for %s', (node) => {
    const input = Schema.decodeUnknownSync(BmcInputSchema)({ node, operation: 'identity' })
    const command = buildBmcInspection(input, '/secrets/bmc')
    expect(command.args).toEqual([
      '-I',
      'lanplus',
      '-C',
      '17',
      '-L',
      'USER',
      '-H',
      node === 'altra' ? '100.100.244.132' : '100.100.244.170',
      '-U',
      'agents-reader',
      '-f',
      `/secrets/bmc/${node}-password`,
      '-N',
      '2',
      '-R',
      '1',
      'mc',
      'info',
    ])
    expect(command.command).toBe('ipmitool')
    expect(command.credentialFiles).toEqual([`/secrets/bmc/${node}-password`])
  })

  it.each([
    ['sensors', ['sdr', 'elist']],
    ['events', ['sel', 'elist', 'last', '50']],
    ['inventory', ['fru', 'print']],
    ['power_status', ['chassis', 'power', 'status']],
    ['module_sensors', ['-m', '0x20', '-b', '0', '-t', '0x82', 'sdr', 'elist']],
  ])('maps %s to an inspection command without accepting argv', (operation, suffix) => {
    const input = Schema.decodeUnknownSync(BmcInputSchema)({ node: 'altra', operation })
    expect(buildBmcInspection(input, '/secrets').args.slice(-suffix.length)).toEqual(suffix)
  })

  it.each(['power_off', 'power_cycle', 'reset', 'fan', 'raw', 'firmware', 'user'])('rejects %s', (operation) => {
    expect(() => Schema.decodeUnknownSync(BmcInputSchema)({ node: 'turin', operation })).toThrow()
  })

  it('pins the Altra SSH target and isolates the forced-command inspection key', () => {
    const command = buildBmcInspection({ node: 'altra', operation: 'fan_state' }, '/secrets/bmc')
    expect(command.command).toBe('ssh')
    expect(command.credentialFiles).toEqual(['/secrets/bmc/altra-ssh-key', '/secrets/bmc/altra-known-hosts'])
    expect(command.args).toEqual(
      expect.arrayContaining([
        'BatchMode=yes',
        'IdentityAgent=none',
        'IdentitiesOnly=yes',
        'PreferredAuthentications=publickey',
        'StrictHostKeyChecking=yes',
        'UserKnownHostsFile=/secrets/bmc/altra-known-hosts',
        'GlobalKnownHostsFile=/dev/null',
        'ClearAllForwardings=yes',
        '/secrets/bmc/altra-ssh-key',
      ]),
    )
    expect(command.args.slice(-2)).toEqual(['sysadmin@100.100.244.132', 'agents-shell-inspect'])
    expect(() => buildBmcInspection({ node: 'turin', operation: 'fan_state' }, '/secrets')).toThrow('only on Altra')
  })

  it('rejects arbitrary targets and unsupported module reads', () => {
    expect(() => Schema.decodeUnknownSync(BmcInputSchema)({ node: 'other-host', operation: 'sensors' })).toThrow()
    expect(() => buildBmcInspection({ node: 'turin', operation: 'module_sensors' }, '/secrets')).toThrow(
      'module_sensors inspection is supported only on Altra',
    )
  })
})
