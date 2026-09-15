import { ensureCli, repoRoot } from './cli'

const digestPattern = /^sha256:[0-9a-f]{64}$/i

export const inspectOciImageDigest = (imageRef: string): string => {
  ensureCli('crane')
  const result = Bun.spawnSync(['crane', 'digest', imageRef], { cwd: repoRoot })
  const stdout = result.stdout.toString().trim()
  const stderr = result.stderr.toString().trim()
  if (result.exitCode !== 0) {
    throw new Error(`crane digest ${imageRef} failed${stderr ? `:\n${stderr}` : ''}`)
  }
  if (!digestPattern.test(stdout)) {
    throw new Error(`crane digest ${imageRef} returned invalid digest: ${stdout}`)
  }
  return stdout
}
