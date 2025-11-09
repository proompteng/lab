import { repoRoot } from './cli'

export const execGit = (args: string[]): string => {
  const result = Bun.spawnSync(['git', ...args], { cwd: repoRoot })
  if (result.exitCode !== 0) {
    throw new Error(`git ${args.join(' ')} failed`)
  }
  return result.stdout.toString().trim()
}
