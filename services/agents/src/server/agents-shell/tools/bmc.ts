import { constants } from 'node:fs'
import { access } from 'node:fs/promises'
import { join } from 'node:path'

import { Effect } from 'effect'
import * as Schema from 'effect/Schema'

import { READ_SCOPES, openReadOnlyAnnotations } from '../constants'
import { agentsShellErrorFromUnknown } from '../errors'
import { type EffectTool, toolSecurityMeta } from '../mcp-adapter'
import { jsonTextResult } from '../results'
import { CliInputSchema, CommandResultSchema } from '../schemas'

export const BmcInputSchema = Schema.Struct({
  node: Schema.Literals(['altra', 'turin']),
  operation: Schema.Literals([
    'identity',
    'sensors',
    'module_sensors',
    'fan_state',
    'events',
    'inventory',
    'power_status',
  ]),
  timeoutSeconds: CliInputSchema.fields.timeoutSeconds,
  maxOutputBytes: CliInputSchema.fields.maxOutputBytes,
})

type BmcInput = typeof BmcInputSchema.Type

const hosts = { altra: '100.100.244.132', turin: '100.100.244.170' }
const reads: Record<Exclude<BmcInput['operation'], 'fan_state'>, string[]> = {
  identity: ['mc', 'info'],
  sensors: ['sdr', 'elist'],
  module_sensors: ['-m', '0x20', '-b', '0', '-t', '0x82', 'sdr', 'elist'],
  events: ['sel', 'elist', 'last', '50'],
  inventory: ['fru', 'print'],
  power_status: ['chassis', 'power', 'status'],
}

export const buildBmcInspection = (input: BmcInput, secretDirectory: string) => {
  if ((input.operation === 'module_sensors' || input.operation === 'fan_state') && input.node !== 'altra') {
    throw new Error(`${input.operation} inspection is supported only on Altra`)
  }
  if (input.operation === 'fan_state') {
    const privateKey = join(secretDirectory, 'altra-ssh-key')
    const knownHosts = join(secretDirectory, 'altra-known-hosts')
    return {
      command: 'ssh',
      credentialFiles: [privateKey, knownHosts],
      args: [
        '-T',
        '-F',
        '/dev/null',
        '-o',
        'BatchMode=yes',
        '-o',
        'LogLevel=ERROR',
        '-o',
        'IdentitiesOnly=yes',
        '-o',
        'IdentityAgent=none',
        '-o',
        'PreferredAuthentications=publickey',
        '-o',
        'StrictHostKeyChecking=yes',
        '-o',
        `UserKnownHostsFile=${knownHosts}`,
        '-o',
        'GlobalKnownHostsFile=/dev/null',
        '-o',
        'UpdateHostKeys=no',
        '-o',
        'ClearAllForwardings=yes',
        '-o',
        'ConnectTimeout=5',
        '-o',
        'ConnectionAttempts=1',
        '-i',
        privateKey,
        `sysadmin@${hosts.altra}`,
        'agents-shell-inspect',
      ],
    }
  }
  const passwordFile = join(secretDirectory, `${input.node}-password`)
  return {
    command: 'ipmitool',
    credentialFiles: [passwordFile],
    args: [
      '-I',
      'lanplus',
      '-C',
      '17',
      '-L',
      'USER',
      '-H',
      hosts[input.node],
      '-U',
      'agents-reader',
      '-f',
      passwordFile,
      '-N',
      '2',
      '-R',
      '1',
      ...reads[input.operation],
    ],
  }
}

export const createBmcTools = (): EffectTool[] => [
  {
    name: 'bmc',
    title: 'Inspect hardware management controllers',
    description:
      'Inspect Altra/Turin BMC identity, sensors, events, inventory or power status. Altra adds module_sensors and fan_state. Read-only.',
    inputSchema: BmcInputSchema,
    outputSchema: CommandResultSchema,
    annotations: openReadOnlyAnnotations,
    scopes: READ_SCOPES,
    ...toolSecurityMeta([READ_SCOPES[0]]),
    handler: (input: BmcInput, { runner, auth }) =>
      Effect.tryPromise({
        try: async () => {
          const inspection = buildBmcInspection(
            input,
            process.env.AGENTS_SHELL_BMC_SECRET_DIR || '/var/run/secrets/agents-shell-bmc',
          )
          await Promise.all(inspection.credentialFiles.map((file) => access(file, constants.R_OK)))
          return jsonTextResult(
            await runner.runProcess({
              command: inspection.command,
              args: inspection.args,
              timeoutSeconds: input.timeoutSeconds,
              maxOutputBytes: input.maxOutputBytes,
              auth,
              auditEvent: 'bmc_inspection',
            }),
          )
        },
        catch: agentsShellErrorFromUnknown,
      }),
  },
]
