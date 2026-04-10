import { readdir, readFile } from 'node:fs/promises'
import { relative, resolve } from 'node:path'

const MAX_NEW_FILE_LINES = 800

const LEGACY_LINE_CAPS: Record<string, number> = {
  'src/server/supporting-primitives-controller.ts': 3352,
  'src/server/codex-judge.ts': 2729,
  'src/server/atlas-store.ts': 2219,
  'src/server/orchestration-controller.ts': 2140,
  'src/server/chat-completion-encoder.ts': 2076,
  'src/server/torghut-market-context-agents.ts': 2036,
  'src/server/agents-controller/index.ts': 1832,
  'src/server/torghut-simulation-control-plane.ts': 1741,
  'src/server/chat.ts': 1537,
  'src/server/github-review-store.ts': 1459,
  'src/server/codex-judge-store.ts': 1329,
  'src/server/torghut-whitepapers.ts': 1328,
  'src/server/agents-controller/workflow-reconciler.ts': 1191,
  'src/server/agents-controller/agent-run-reconciler.ts': 1191,
  'src/server/agentctl-grpc.ts': 1171,
  'src/server/terminals.ts': 1029,
  'src/routes/github/pulls/$owner/$repo/$number.tsx': 1028,
  'src/server/db.ts': 1017,
  'src/server/torghut-trading.ts': 988,
  'src/routes/torghut/trading.tsx': 980,
  'src/server/agents-controller/vcs-context.ts': 975,
  'src/server/torghut-quant-metrics.ts': 929,
  'src/server/github-review-actions.ts': 928,
  'src/server/github-client.ts': 905,
  'src/server/implementation-source-webhooks.ts': 900,
  'src/routes/atlas/search.tsx': 891,
  'src/routes/v1/agent-runs.ts': 886,
  'src/routes/control-plane/implementation-specs/$name.tsx': 862,
  'src/server/torghut-quant-runtime.ts': 818,
}

const ROOT = process.cwd()
const SCAN_DIRS = ['src/server', 'src/routes', 'src/components']

const shouldCheckFile = (path: string) => {
  if (!path.endsWith('.ts') && !path.endsWith('.tsx')) return false
  if (
    path.endsWith('.test.ts') ||
    path.endsWith('.test.tsx') ||
    path.endsWith('.spec.ts') ||
    path.endsWith('.spec.tsx')
  ) {
    return false
  }
  if (path.includes('/__tests__/')) return false
  if (path === 'src/routeTree.gen.ts') return false
  return true
}

const walk = async (directory: string): Promise<string[]> => {
  const entries = await readdir(directory, { withFileTypes: true })
  const files: string[] = []

  for (const entry of entries) {
    const absolutePath = resolve(directory, entry.name)
    if (entry.isDirectory()) {
      files.push(...(await walk(absolutePath)))
      continue
    }
    if (!entry.isFile()) continue
    files.push(absolutePath)
  }

  return files
}

const countLines = async (path: string) => {
  const content = await readFile(path, 'utf8')
  return content.length === 0 ? 0 : content.split('\n').length
}

const main = async () => {
  const candidates = await Promise.all(SCAN_DIRS.map((directory) => walk(resolve(ROOT, directory))))
  const files = candidates
    .flat()
    .map((path) => relative(ROOT, path))
    .filter(shouldCheckFile)
    .sort()

  const failures: string[] = []

  for (const file of files) {
    const lineCount = await countLines(resolve(ROOT, file))
    const legacyCap = LEGACY_LINE_CAPS[file]

    if (legacyCap !== undefined) {
      if (lineCount > legacyCap) {
        failures.push(`${file} grew from ${legacyCap} lines to ${lineCount}; legacy oversized files must only shrink.`)
      }
      continue
    }

    if (lineCount > MAX_NEW_FILE_LINES) {
      failures.push(`${file} is ${lineCount} lines; new modules must stay at or below ${MAX_NEW_FILE_LINES} lines.`)
    }
  }

  if (failures.length > 0) {
    console.error('Jangar module-size guardrail failed:')
    for (const failure of failures) {
      console.error(`- ${failure}`)
    }
    process.exit(1)
  }

  console.log(
    `Jangar module-size guardrail passed for ${files.length} files. Legacy oversized files stayed within baseline caps.`,
  )
}

await main()
