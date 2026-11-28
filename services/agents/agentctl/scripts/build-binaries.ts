import { chmod, copyFile, mkdir } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { resolveHostTarget, resolveTargets } from './targets'

const scriptDir = dirname(fileURLToPath(import.meta.url))
const root = resolve(scriptDir, '..')
const entry = resolve(root, 'src/index.ts')
const distDir = resolve(root, 'dist')

const signBinary = async (codesign: string, path: string) => {
  const proc = Bun.spawn([codesign, '-s', '-', '--force', path], {
    stderr: 'inherit',
    stdout: 'inherit',
  })
  const exitCode = await proc.exited
  if (exitCode !== 0) {
    throw new Error(`codesign failed for ${path} with exit code ${exitCode}`)
  }
}

export const buildBinaries = async (argv: string[]) => {
  const targets = resolveTargets(argv, process.env.AGENTCTL_TARGETS)
  const hostLabel = resolveHostTarget().label
  const codesign = process.platform === 'darwin' ? Bun.which('codesign') : null

  await mkdir(distDir, { recursive: true })

  for (const target of targets) {
    const output = resolve(distDir, `agentctl-${target.label}`)
    console.log(`Building ${target.bunTarget} → ${output}`)

    const proc = Bun.spawn(
      [
        'bun',
        'build',
        entry,
        '--compile',
        '--compile-autoload-package-json',
        '--format=esm',
        // Protobuf's dynamic require needs a binding to use Buffer in the ESM bundle.
        '--banner',
        'const require = import.meta.require;',
        '--target',
        target.bunTarget,
        '--outfile',
        output,
      ],
      {
        cwd: root,
        stderr: 'inherit',
        stdout: 'inherit',
      },
    )

    const exitCode = await proc.exited
    if (exitCode !== 0) {
      throw new Error(`bun build failed for ${target.bunTarget} with exit code ${exitCode}`)
    }

    await chmod(output, 0o755)
    const signer = target.platform === 'darwin' ? codesign : null
    if (signer) await signBinary(signer, output)

    if (target.label === hostLabel) {
      const hostBinary = resolve(distDir, 'agentctl')
      await copyFile(output, hostBinary)
      await chmod(hostBinary, 0o755)
      // Copying the executable can invalidate its Mach-O signature.
      if (signer) await signBinary(signer, hostBinary)
      console.log(`Linked host binary → ${hostBinary}`)
    }
  }
}

if (import.meta.main) {
  buildBinaries(Bun.argv.slice(2)).catch((error) => {
    console.error(error instanceof Error ? error.message : error)
    process.exit(1)
  })
}
