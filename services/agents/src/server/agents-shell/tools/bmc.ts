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
  node: Schema.Literal('altra', 'turin'),
  operation: Schema.Literal('identity', 'sensors', 'module_sensors', 'events', 'inventory', 'power_status'),
  timeoutSeconds: CliInputSchema.fields.timeoutSeconds,
  maxOutputBytes: CliInputSchema.fields.maxOutputBytes,
})

type BmcInput = typeof BmcInputSchema.Type

const hosts = { altra: '192.168.0.100', turin: '100.100.244.170' }
const reads: Record<BmcInput['operation'], string[]> = {
  identity: ['mc', 'info'],
  sensors: ['sdr', 'elist'],
  module_sensors: ['-m', '0x20', '-b', '0', '-t', '0x82', 'sdr', 'elist'],
  events: ['sel', 'elist', 'last', '50'],
  inventory: ['fru', 'print'],
  power_status: ['chassis', 'power', 'status'],
}

export const buildBmcInspection = (input: BmcInput, secretDirectory: string) => {
  if (input.operation === 'module_sensors' && input.node !== 'altra') {
    throw new Error('Module sensor inspection is supported only on Altra')
  }
  const passwordFile = join(secretDirectory, `${input.node}-password`)
  return {
    passwordFile,
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
      'Read Altra/Turin BMC identity, sensors, events, inventory or power status. module_sensors is Altra-only. No controls or raw commands.',
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
          await access(inspection.passwordFile, constants.R_OK)
          return jsonTextResult(
            await runner.runProcess({
              command: 'ipmitool',
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
