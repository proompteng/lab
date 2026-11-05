import { Effect } from 'effect'
import * as Schema from 'effect/Schema'

import { normalizeCliArgs } from '../cli-policy'
import { READ_SCOPES, openReadOnlyAnnotations } from '../constants'
import { agentsShellErrorFromUnknown } from '../errors'
import { type EffectTool, toolSecurityMeta } from '../mcp-adapter'
import { jsonTextResult } from '../results'
import { CliInputSchema, CommandResultSchema } from '../schemas'

const InspectionInputSchema = Schema.Struct({
  command: Schema.Literal('talosctl', 'omnictl'),
  args: CliInputSchema.fields.args,
  timeoutSeconds: CliInputSchema.fields.timeoutSeconds,
  maxOutputBytes: CliInputSchema.fields.maxOutputBytes,
})

const inspectionCommands = {
  talosctl: {
    verbs: new Set([
      'version',
      'get',
      'dmesg',
      'logs',
      'processes',
      'memory',
      'netstat',
      'containers',
      'mounts',
      'time',
      'stats',
    ]),
    values: new Set(['-n', '--nodes', '-o', '--output', '--namespace', '--tail', '--since']),
    flags: new Set(['-h', '--help', '--client', '-w', '--watch', '-f', '--follow', '--timestamps', '--kubernetes']),
  },
  omnictl: {
    verbs: new Set(['get', 'machine-logs', '--version']),
    values: new Set(['-n', '--namespace', '-o', '--output', '-l', '--selector', '--id-match-regexp', '--tail']),
    flags: new Set(['-h', '--help', '-w', '--watch', '-f', '--follow']),
  },
}

export type InspectionCommand = keyof typeof inspectionCommands

export const requireInfrastructureInspectionArgs = (command: InspectionCommand, args: string[]) => {
  const policy = inspectionCommands[command]
  if (!policy.verbs.has(args[0])) throw new Error(`${command} requires an allowed inspection verb first`)
  for (let index = 1; index < args.length; index += 1) {
    const argument = args[index]
    if (!argument.startsWith('-')) continue
    const separator = argument.indexOf('=')
    const flag = separator < 0 ? argument : argument.slice(0, separator)
    if (policy.flags.has(flag) && separator < 0) continue
    if (!policy.values.has(flag)) throw new Error(`${command} inspection does not allow ${flag}`)
    if (separator >= 0) {
      if (separator === argument.length - 1) throw new Error(`${flag} requires a value`)
    } else {
      index += 1
      if (!args[index] || args[index].startsWith('-')) throw new Error(`${flag} requires a value`)
    }
  }
}

export const createInfrastructureTools = (): EffectTool[] => [
  {
    name: 'infrastructure',
    title: 'Inspect Talos and Omni',
    description:
      'Inspect Talos or Omni using Reader. Pass the verb first in args; Talos --nodes takes machine UUIDs. No raw files or mutations.',
    inputSchema: InspectionInputSchema,
    outputSchema: CommandResultSchema,
    annotations: openReadOnlyAnnotations,
    scopes: READ_SCOPES,
    ...toolSecurityMeta([READ_SCOPES[0]]),
    handler: (args: typeof InspectionInputSchema.Type, { runner, auth }) =>
      Effect.tryPromise({
        try: async () => {
          const command = args.command
          const argv = normalizeCliArgs(command, args.args)
          requireInfrastructureInspectionArgs(command, argv)
          return jsonTextResult(
            await runner.runProcess({
              command,
              args: argv,
              timeoutSeconds: args.timeoutSeconds,
              maxOutputBytes: args.maxOutputBytes,
              auth,
              auditEvent: command,
            }),
          )
        },
        catch: agentsShellErrorFromUnknown,
      }),
  },
]
