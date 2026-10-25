type CommandRequest = {
  args: string[]
  cwd: string
  env?: Record<string, string | undefined>
  timeoutMs: number
}

globalThis.onmessage = (event: MessageEvent<CommandRequest>) => {
  try {
    const result = Bun.spawnSync(event.data.args, {
      cwd: event.data.cwd,
      detached: true,
      env: event.data.env ? { ...process.env, ...event.data.env } : process.env,
      stdout: 'pipe',
      stderr: 'pipe',
      timeout: event.data.timeoutMs,
    })
    if (result.exitCode === null) {
      try {
        process.kill(-result.pid, 'SIGKILL')
      } catch (error) {
        const code = error instanceof Error && 'code' in error ? error.code : undefined
        if (code !== 'ESRCH') throw error
      }
    }
    globalThis.postMessage({
      exitCode: result.exitCode,
      stdout: result.stdout.toString(),
      stderr: result.stderr.toString(),
    })
  } catch (error) {
    globalThis.postMessage({
      exitCode: 1,
      stdout: '',
      stderr: error instanceof Error ? error.message : String(error),
    })
  }
}
