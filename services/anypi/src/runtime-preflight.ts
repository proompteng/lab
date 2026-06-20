import { runCommand } from './command'

export type RuntimeToolCheck = {
  tool: string
  ok: boolean
  path?: string
  error?: string
}

const TOOL_NAME_PATTERN = /^[A-Za-z0-9._+-]+$/

const assertToolName = (tool: string) => {
  if (!TOOL_NAME_PATTERN.test(tool)) {
    throw new Error(`invalid runtime tool name: ${tool}`)
  }
}

export const checkRuntimeTool = async (
  tool: string,
  cwd: string,
  env?: Record<string, string | undefined>,
): Promise<RuntimeToolCheck> => {
  assertToolName(tool)
  const result = await runCommand('sh', ['-lc', `command -v ${tool}`], {
    cwd,
    env,
    allowFailure: true,
  })
  const path = result.stdout.trim()
  return result.exitCode === 0 && path
    ? { tool, ok: true, path }
    : { tool, ok: false, error: (result.stderr || result.stdout || `missing ${tool}`).trim() }
}

export const verifyRequiredRuntimeTools = async (
  tools: string[],
  cwd: string,
  log: (message: string) => Promise<void>,
  env?: Record<string, string | undefined>,
) => {
  const checks: RuntimeToolCheck[] = []
  for (const tool of tools) {
    const check = await checkRuntimeTool(tool, cwd, env)
    checks.push(check)
    await log(
      check.ok
        ? `runtime tool ready: ${check.tool} (${check.path})`
        : `runtime tool missing: ${check.tool}${check.error ? ` (${check.error})` : ''}`,
    )
  }

  const missing = checks.filter((check) => !check.ok)
  if (missing.length > 0) {
    throw new Error(
      `runtime preflight failed: missing required tools: ${missing.map((check) => check.tool).join(', ')}`,
    )
  }

  return checks
}
