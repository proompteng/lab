import { describe, expect, test } from 'bun:test'

const commandPath = new URL('./qualification-audit-command.ts', import.meta.url).pathname
const secretMarkers = ['postgres-secret-marker', 'signal-secret-marker', 'audit-secret-marker'] as const

const runCommand = async (output: 'audit' | 'dossier') => {
  const child = Bun.spawn({
    cmd: [process.execPath, commandPath],
    cwd: import.meta.dir,
    env: {
      ...process.env,
      NODE_ENV: 'test',
      BAYN_AUDIT_OUTPUT: output,
      BAYN_AUDIT_RUN_ID: '0'.repeat(64),
      BAYN_AUDIT_POSTGRES_URL: `postgresql://audit:${secretMarkers[0]}@127.0.0.1:1/bayn_audit_test`,
      BAYN_AUDIT_POSTGRES_TLS: 'false',
      BAYN_AUDIT_SIGNAL_URL: 'http://127.0.0.1:1',
      BAYN_AUDIT_SIGNAL_USERNAME: 'bayn-audit-candidate',
      BAYN_AUDIT_SIGNAL_PUBLISHER_USERNAME: 'bayn-audit-publisher',
      BAYN_AUDIT_SIGNAL_PASSWORD: secretMarkers[1],
      BAYN_AUDIT_CLICKHOUSE_URLS: 'http://127.0.0.1:1,http://127.0.0.1:2',
      BAYN_AUDIT_CLICKHOUSE_USERNAME: 'bayn-audit-query-log',
      BAYN_AUDIT_CLICKHOUSE_PASSWORD: secretMarkers[2],
      BAYN_AUDIT_REPOSITORY_PATH: import.meta.dir,
      BAYN_AUDIT_OPERATION_TIMEOUT_MS: '100',
    },
    stdout: 'pipe',
    stderr: 'pipe',
  })
  const [exitCode, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ])
  return { exitCode, stdout, stderr }
}

describe('qualification audit command', () => {
  for (const output of ['audit', 'dossier'] as const) {
    test(`fails closed without exposing credentials in ${output} test mode`, async () => {
      const result = await runCommand(output)
      const outputText = `${result.stdout}\n${result.stderr}`

      expect(result.exitCode).not.toBe(0)
      expect(outputText).toContain('PostgreSQL read-only qualification audit failed')
      for (const secret of secretMarkers) {
        expect(outputText).not.toContain(secret)
      }
    })
  }
})
