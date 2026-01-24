#!/usr/bin/env bun

import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { ensureCli, fatal, repoRoot, run } from '../shared/cli'

const DEFAULT_REGISTRY = 'registry.ide-newton.ts.net/lab'
const DEFAULT_TALOS_VERSION = 'v1.12.1'
const DEFAULT_FIRECRACKER_VERSION = 'v1.12.1'
const DEFAULT_TAG_SUFFIX = 'fc2'

type TagConfig = {
  installerTag: string
  extensionTag: string
}

const parseArgs = (): TagConfig => {
  const args = Bun.argv.slice(2)
  if (args.length > 2) {
    fatal('Usage: build-firecracker-installer.ts [tag-suffix | installer-tag extension-tag]')
  }
  if (args.length === 2) {
    return { installerTag: args[0], extensionTag: args[1] }
  }
  if (args.length === 1) {
    const tag = args[0]
    if (tag.includes('/') || tag.includes(':')) {
      fatal('When passing a full installer tag, provide the extension tag as the second arg.')
    }
    return {
      installerTag: `${DEFAULT_REGISTRY}/installer-firecracker:${tag}`,
      extensionTag: `${DEFAULT_REGISTRY}/talos-ext-firecracker:${tag}`,
    }
  }
  const tagSuffix = process.env.FIRECRACKER_TAG_SUFFIX ?? DEFAULT_TAG_SUFFIX
  return {
    installerTag: `${DEFAULT_REGISTRY}/installer-firecracker:${DEFAULT_TALOS_VERSION}-${tagSuffix}`,
    extensionTag: `${DEFAULT_REGISTRY}/talos-ext-firecracker:${DEFAULT_FIRECRACKER_VERSION}-${tagSuffix}`,
  }
}

const runCapture = async (command: string, args: string[]) => {
  console.log(`$ ${command} ${args.join(' ')}`.trim())
  const proc = Bun.spawn([command, ...args], {
    stdout: 'pipe',
    stderr: 'inherit',
  })
  const output = await new Response(proc.stdout).text()
  const exitCode = await proc.exited
  if (exitCode !== 0) {
    fatal(`Command failed (${exitCode}): ${command} ${args.join(' ')}`)
  }
  return output
}

const resolveExtensionImages = async (talosVersion: string) => {
  const digestList = await runCapture('sh', [
    '-c',
    `crane export ghcr.io/siderolabs/extensions:${talosVersion} - | tar -xO image-digests`,
  ])

  const lines = digestList
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)

  const findImage = (name: string) => {
    const match = lines.find((line) => line.startsWith(`ghcr.io/siderolabs/${name}:`))
    if (!match) {
      fatal(`Unable to find ${name} extension image for Talos ${talosVersion}`)
    }
    return match
  }

  return {
    kataContainers: findImage('kata-containers'),
    glibc: findImage('glibc'),
    tailscale: findImage('tailscale'),
  }
}

const buildExtension = async (tag: string, firecrackerVersion: string) => {
  const dockerfile = resolve(repoRoot, 'devices/ryzen/extensions/firecracker/Dockerfile')
  const context = resolve(repoRoot, 'devices/ryzen/extensions/firecracker')

  await run('docker', [
    'buildx',
    'build',
    '--platform=linux/amd64',
    '--provenance=false',
    '-t',
    tag,
    '--build-arg',
    `FIRECRACKER_VERSION=${firecrackerVersion}`,
    '-f',
    dockerfile,
    context,
    '--push',
  ])
}

const buildInstaller = async (installerTag: string, talosVersion: string, extensionImages: string[]) => {
  const outputDir = mkdtempSync(`${tmpdir()}/talos-imager-`)
  try {
    const imagerImage = `ghcr.io/siderolabs/imager:${talosVersion}`
    const args = [
      'run',
      '--rm',
      '-v',
      `${outputDir}:/out`,
      imagerImage,
      'installer',
      '--arch',
      'amd64',
      '--platform',
      'metal',
      '--output',
      '/out',
      ...extensionImages.flatMap((image) => ['--system-extension-image', image]),
    ]

    await run('docker', args)

    const loadOutput = await runCapture('docker', ['load', '-i', `${outputDir}/installer-amd64.tar`])
    const match = loadOutput.match(/Loaded image: (.+)/)
    if (!match) {
      fatal('Unable to determine loaded installer image name')
    }

    const loadedImage = match[1]
    await run('docker', ['tag', loadedImage, installerTag])
    await run('docker', ['push', installerTag])
  } finally {
    rmSync(outputDir, { recursive: true, force: true })
  }
}

const main = async () => {
  ensureCli('docker')
  ensureCli('crane')

  const { installerTag, extensionTag } = parseArgs()
  const talosVersion = process.env.TALOS_VERSION ?? DEFAULT_TALOS_VERSION
  const firecrackerVersion = process.env.FIRECRACKER_VERSION ?? DEFAULT_FIRECRACKER_VERSION

  const { kataContainers, glibc, tailscale } = await resolveExtensionImages(talosVersion)

  await buildExtension(extensionTag, firecrackerVersion)

  await buildInstaller(installerTag, talosVersion, [kataContainers, glibc, tailscale, extensionTag])

  console.log(`Built and pushed ${installerTag}`)
  console.log(`Update devices/ryzen/manifests/installer-image.patch.yaml to use this tag.`)
}

if (import.meta.main) {
  main().catch((error) => fatal('Failed to build Firecracker installer image', error))
}
