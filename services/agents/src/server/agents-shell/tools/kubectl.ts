import { Effect } from 'effect'

import { READ_SCOPES, WRITE_SCOPES, destructiveAnnotations, openReadOnlyAnnotations } from '../constants'
import { normalizeCliArgs, requireReadOnlyKubectlArgs } from '../cli-policy'
import { agentsShellErrorFromUnknown } from '../errors'
import { toolSecurityMeta, type EffectTool } from '../mcp-adapter'
import { jsonTextResult } from '../results'
import { CliInputSchema, CommandResultSchema, type CliInput } from '../schemas'

export const createKubectlTools = (): EffectTool[] => [
  {
    name: 'kubectl',
    title: 'Inspect Kubernetes with kubectl',
    description: 'Run read-only kubectl inspection. Pass argv after kubectl.',
    inputSchema: CliInputSchema,
    outputSchema: CommandResultSchema,
    annotations: openReadOnlyAnnotations,
    scopes: READ_SCOPES,
    ...toolSecurityMeta([READ_SCOPES[0]]),
    handler: (args: CliInput, { runner, auth }) =>
      Effect.tryPromise({
        try: async () => {
          const kubectlArgs = normalizeCliArgs('kubectl', args.args)
          requireReadOnlyKubectlArgs(kubectlArgs)
          return jsonTextResult(
            await runner.runProcess({
              command: 'kubectl',
              args: kubectlArgs,
              cwd: args.cwd,
              timeoutSeconds: args.timeoutSeconds,
              maxOutputBytes: args.maxOutputBytes,
              okExitCodes: kubectlArgs[0] === 'diff' ? [0, 1] : [0],
              auth,
              auditEvent: 'kubectl',
            }),
          )
        },
        catch: agentsShellErrorFromUnknown,
      }),
  },
  {
    name: 'kubectl_admin',
    title: 'Run admin kubectl',
    description: 'Run admin kubectl operations allowed by the agents-shell ServiceAccount. Pass argv after kubectl.',
    inputSchema: CliInputSchema,
    outputSchema: CommandResultSchema,
    annotations: destructiveAnnotations,
    scopes: WRITE_SCOPES,
    ...toolSecurityMeta([READ_SCOPES[0]]),
    handler: (args: CliInput, { runner, auth }) =>
      Effect.tryPromise({
        try: async () => {
          const kubectlArgs = normalizeCliArgs('kubectl_admin', args.args)
          return jsonTextResult(
            await runner.runProcess({
              command: 'kubectl',
              args: kubectlArgs,
              cwd: args.cwd,
              timeoutSeconds: args.timeoutSeconds,
              maxOutputBytes: args.maxOutputBytes,
              okExitCodes: kubectlArgs[0] === 'diff' ? [0, 1] : [0],
              auth,
              auditEvent: 'kubectl_admin',
            }),
          )
        },
        catch: agentsShellErrorFromUnknown,
      }),
  },
]
