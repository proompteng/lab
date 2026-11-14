import { afterEach, expect, test } from 'bun:test'
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('../../../../../', import.meta.url))
const image = readFileSync(join(root, 'nix/images/bayn.nix'), 'utf8')
const temporary: string[] = []
const scratch = () => {
  const path = mkdtempSync(join(tmpdir(), 'bayn-study-image-'))
  temporary.push(path)
  return path
}
afterEach(() => {
  for (const path of temporary.splice(0)) rmSync(path, { recursive: true, force: true })
})
const put = (base: string, path: string, text = '', executable = false) => {
  const target = join(base, path)
  mkdirSync(dirname(target), { recursive: true })
  writeFileSync(target, text)
  if (executable) chmodSync(target, 0o755)
}
const run = (args: string[], env: Record<string, string | undefined> = {}) => {
  const result = Bun.spawnSync(args, { env: { ...process.env, ...env } })
  return { code: result.exitCode, stdout: result.stdout.toString(), stderr: result.stderr.toString() }
}

test('the study exporter is compiled and installed only in the research runtime', () => {
  const commands = image.match(/runtimeCommands = if research then \[([\s\S]*?)\] else \[([\s\S]*?)\];/)
  expect(commands).not.toBeNull()
  expect(commands?.[1]).toContain('"jev-study-export-command"')
  expect(commands?.[2]).not.toContain('"jev-study-export-command"')
  expect(image).toContain('bun build services/bayn/src/jev-study-export-command.ts --target=node')
  expect(image).toContain('node services/bayn/dist/jev-study-export-command.js --help')
  const extras = image.split('extraContents = [')[1]
  expect(extras?.split('lib.optionals research [')[0]).not.toContain('studyExportCommand')
  expect(extras?.split('lib.optionals research [')[1]).toContain('studyExportCommand')
})

test('the installed wrapper invokes image Node and forwards arguments without configuration', () => {
  const body = image.match(
    /studyExportCommand = pkgs.writeShellScriptBin "bayn-jev-study-export" ''\n([\s\S]*?)\n  '';/,
  )?.[1]
  expect(body).toBeDefined()
  const path = scratch()
  put(path, 'bin/node', '#!/bin/sh\nprintf "%s\\n" "$@"\n', true)
  put(path, 'wrapper', body!.replaceAll("''${", '${'))
  const result = run(['bash', join(path, 'wrapper'), '--session', '2026-11-11', '--output', '/private/with spaces'], {
    BAYN_IMAGE_ROOT: path,
  })
  expect(result.code).toBe(0)
  expect(result.stdout.trim().split('\n')).toEqual([
    `${path}/app/services/bayn/dist/jev-study-export-command.js`,
    '--session',
    '2026-11-11',
    '--output',
    '/private/with spaces',
  ])
})

const archive = (
  role: 'research' | 'trading',
  options: { bundle?: boolean; wrapper?: boolean; screenBundle?: boolean; screenWrapper?: boolean } = {},
) => {
  const path = scratch()
  const fs = join(path, 'rootfs')
  const tarRoot = join(path, 'archive')
  mkdirSync(tarRoot)
  put(fs, 'bin/node', '#!/bin/sh\nexit 0\n', true)
  const commands =
    role === 'research'
      ? [
          'restate-research-server',
          'system-assessment-command',
          'forward-performance-command',
          'research-command',
          'webull-research-command',
          'jev-evaluation-command',
          'backtest-command',
          'frozen-control-command',
          'control-study-command',
          'native-arrival-export-command',
        ]
      : [
          'index',
          'restate-execution-server',
          'restate-execution-activate',
          'market-projection-worker',
          'decision-construction-worker',
          'forward-performance-command',
          'control-opening-command',
          'inference-cost-command',
          'streaming-diagnostics-command',
          'glitchtip-smoke-command',
          'valkey-command',
          'backtest-command',
        ]
  for (const command of commands)
    put(
      fs,
      `app/services/bayn/dist/${command}.js`,
      'this.#connectController?.abort()\nthis.#connectWithSignal(retries, controller.signal)\nAbortSignal.any([withDefaults.signal, signal])',
    )
  const wrappers =
    role === 'research'
      ? [
          'system-assessment',
          'forward-performance',
          'research',
          'webull-research',
          'jev-evaluate',
          'backtest',
          'frozen-control-backtest',
          'control-study',
          'native-arrival-export',
          'gepa',
          'gepa-native',
        ]
      : ['inference-cost', 'forward-performance', 'control-opening']
  for (const command of wrappers) put(fs, `bin/bayn-${command}`, '#!/bin/sh\nexit 0\n', true)
  put(fs, 'app/services/bayn/dist/jev-compiler-dependencies.json', '{}')
  if (role === 'research') {
    put(fs, 'app/services/bayn/dist/frozen-control-compiler.json', '{}')
    for (const runner of ['runner', 'native']) put(fs, `app/services/bayn/gepa/${runner}.py`)
    for (const command of ['git', 'bun', 'crane']) put(fs, `bin/${command}`, '#!/bin/sh\nexit 0\n', true)
  }
  if (options.bundle) put(fs, 'app/services/bayn/dist/jev-study-export-command.js')
  if (options.wrapper) put(fs, 'bin/bayn-jev-study-export', '#!/bin/sh\nexit 0\n', true)
  if (options.screenBundle ?? role === 'research') put(fs, 'app/services/bayn/dist/equity-edge-screen.js')
  if (options.screenWrapper ?? role === 'research') put(fs, 'bin/bayn-equity-edge-screen', '#!/bin/sh\nexit 0\n', true)
  expect(run(['tar', '-cf', join(tarRoot, 'layer.tar'), '-C', fs, '.']).code).toBe(0)
  put(tarRoot, 'manifest.json', JSON.stringify([{ Layers: ['layer.tar'] }]))
  const result = join(path, 'image.tar')
  expect(run(['tar', '-cf', result, '-C', tarRoot, '.']).code).toBe(0)
  return run(['bash', join(root, 'nix/verify-bayn-image-command.sh'), result, role], {
    BAYN_VERIFY_ALLOW_NON_NIX_ARCHIVE: 'true',
  })
}

test('the research archive requires the exporter bundle and executable together', () => {
  expect(archive('research', { bundle: true, wrapper: true }).code).toBe(0)
  const missingBundle = archive('research', { wrapper: true })
  expect(missingBundle.code).not.toBe(0)
  expect(missingBundle.stderr).toContain('jev-study-export-command.js')
  const missingWrapper = archive('research', { bundle: true })
  expect(missingWrapper.code).not.toBe(0)
  expect(missingWrapper.stderr).toContain('bayn-jev-study-export')
})

test('the trading archive rejects either exporter artifact', () => {
  expect(archive('trading').code).toBe(0)
  const bundle = archive('trading', { bundle: true })
  expect(bundle.code).not.toBe(0)
  expect(bundle.stderr).toContain('research bundle jev-study-export-command')
  const wrapper = archive('trading', { wrapper: true })
  expect(wrapper.code).not.toBe(0)
  expect(wrapper.stderr).toContain('research executable bayn-jev-study-export')
})

test('the research archive requires both equity-screen artifacts and trading rejects either one', () => {
  const missingBundle = archive('research', { bundle: true, wrapper: true, screenBundle: false })
  expect(missingBundle.code).not.toBe(0)
  expect(missingBundle.stderr).toContain('equity-edge-screen.js')
  const missingWrapper = archive('research', { bundle: true, wrapper: true, screenWrapper: false })
  expect(missingWrapper.code).not.toBe(0)
  expect(missingWrapper.stderr).toContain('bayn-equity-edge-screen')
  const bundle = archive('trading', { screenBundle: true })
  expect(bundle.code).not.toBe(0)
  expect(bundle.stderr).toContain('research bundle equity-edge-screen')
  const wrapper = archive('trading', { screenWrapper: true })
  expect(wrapper.code).not.toBe(0)
  expect(wrapper.stderr).toContain('research executable bayn-equity-edge-screen')
})

test('the equity-screen wrapper invokes image Node and preserves pinned input arguments', () => {
  const body = image.match(
    /equityEdgeScreenCommand = pkgs.writeShellScriptBin "bayn-equity-edge-screen" ''\n([\s\S]*?)\n  '';/,
  )?.[1]
  expect(body).toBeDefined()
  const path = scratch()
  put(path, 'bin/node', '#!/bin/sh\nprintf "%s\\n" "$@"\n', true)
  put(path, 'wrapper', body!.replaceAll("''${", '${'))
  const args = [
    '--input',
    '/private/with spaces/input.json',
    '--input-sha256',
    'a'.repeat(64),
    '--source',
    '/private/pages.ndjson',
    '--output',
    '/private/new report.json',
  ]
  const result = run(['bash', join(path, 'wrapper'), ...args], { BAYN_IMAGE_ROOT: path })
  expect(result.code).toBe(0)
  expect(result.stdout.trim().split('\n')).toEqual([`${path}/app/services/bayn/dist/equity-edge-screen.js`, ...args])
})
