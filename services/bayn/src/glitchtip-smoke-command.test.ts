import { expect, test } from 'bun:test'

test('the actual smoke command fails when the SDK cannot capture despite a successful empty flush', () => {
  const child = Bun.spawnSync({
    cmd: [
      process.execPath,
      '--preload',
      new URL('./testing/glitchtip-smoke-sdk-failure.ts', import.meta.url).pathname,
      new URL('./glitchtip-smoke-command.ts', import.meta.url).pathname,
    ],
    env: {
      ...process.env,
      BAYN_GLITCHTIP_DSN: 'http://591bd90be7b84b22856ec7c1bd456ec2@glitchtip-web.glitchtip.svc.cluster.local/1',
    },
  })
  expect(child.exitCode).toBe(1)
  const output = child.stdout.toString() + child.stderr.toString()
  expect(output).not.toContain('Synthetic failed cycle pass was captured and flushed')
  expect(output).toContain('GlitchTip cycle failure could not be captured')
})

test('the controller smoke fails when only the native arrival capture is missing', () => {
  const child = Bun.spawnSync({
    cmd: [
      process.execPath,
      '--preload',
      new URL('./testing/glitchtip-smoke-native-sdk-failure.ts', import.meta.url).pathname,
      new URL('./glitchtip-smoke-command.ts', import.meta.url).pathname,
    ],
    env: {
      ...process.env,
      BAYN_GLITCHTIP_DSN: 'http://591bd90be7b84b22856ec7c1bd456ec2@glitchtip-web.glitchtip.svc.cluster.local/1',
      BAYN_ERROR_TRACKING_SERVICE: 'bayn-execution-controller',
    },
  })
  expect(child.exitCode).toBe(1)
  const output = child.stdout.toString() + child.stderr.toString()
  expect(output).toContain('GlitchTip native arrival failure could not be captured')
  expect(output).not.toContain('Synthetic failed cycle pass was captured and flushed')
})
