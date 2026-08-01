import { execFile } from 'node:child_process'
import { Result } from 'effect'

export const successOf = <A, E>(result: Result.Result<A, E>): A => {
  if (Result.isFailure(result)) throw new Error('expected Result success')
  return result.success
}

export const execFilePromise = (file: string, args: readonly string[], cwd: string): Promise<void> =>
  new Promise((resolveExecution, rejectExecution) => {
    execFile(file, [...args], { cwd }, (error) => {
      if (error === null) resolveExecution()
      else rejectExecution(error)
    })
  })

export const execFileTextPromise = (file: string, args: readonly string[], cwd: string): Promise<string> =>
  new Promise((resolveExecution, rejectExecution) => {
    execFile(file, [...args], { cwd, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 }, (error, stdout) => {
      if (error === null) resolveExecution(stdout.trim())
      else rejectExecution(error)
    })
  })

export const execFileBytesPromise = (file: string, args: readonly string[], cwd: string): Promise<Buffer> =>
  new Promise((resolveExecution, rejectExecution) => {
    execFile(file, [...args], { cwd, encoding: 'buffer', maxBuffer: 64 * 1024 * 1024 }, (error, stdout) => {
      if (error === null) resolveExecution(stdout)
      else rejectExecution(error)
    })
  })

export const execFileResultPromise = (
  file: string,
  args: readonly string[],
  cwd: string,
): Promise<{ readonly exitCode: number; readonly stdout: string; readonly stderr: string }> =>
  new Promise((resolveExecution) => {
    execFile(file, [...args], { cwd, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 }, (error, stdout, stderr) => {
      resolveExecution({
        exitCode: error === null ? 0 : typeof error.code === 'number' ? error.code : 1,
        stdout,
        stderr,
      })
    })
  })
