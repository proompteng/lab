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
    description:
      'Inspect Kubernetes resources; pod exec (even read-only diagnostics) uses kubectl_admin. Pass argv after kubectl. No repo session.',
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
              sessionId: args.sessionId,
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
    description:
      'Run kubectl exec (including read-only diagnostics) or authorized administration. Pass argv after kubectl. No repo session.',
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
              sessionId: args.sessionId,
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
