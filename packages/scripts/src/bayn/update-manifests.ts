#!/usr/bin/env bun

import { readFileSync, writeFileSync } from 'node:fs'
import process from 'node:process'

const digestPattern = /^sha256:[0-9a-f]{64}$/
const sourceShaPattern = /^[0-9a-f]{40}$/
const tagPattern = /^[A-Za-z0-9._-]{1,128}$/

export interface UpdateBaynManifestOptions {
  readonly sourceSha: string
  readonly tag: string
  readonly digest: string
  readonly rolloutTimestamp: string
  readonly kustomizationPath?: string
  readonly deploymentPath?: string
  readonly applicationSetPath?: string
}

const replaceExactlyOnce = (source: string, pattern: RegExp, replacement: string, name: string): string => {
  const matches = [...source.matchAll(new RegExp(pattern.source, `${pattern.flags.replace('g', '')}g`))]
  if (matches.length !== 1) throw new Error(`expected exactly one ${name}`)
  return source.replace(pattern, replacement)
}

export const updateBaynManifests = (options: UpdateBaynManifestOptions): void => {
  if (!sourceShaPattern.test(options.sourceSha)) throw new Error(`invalid source SHA: ${options.sourceSha}`)
  if (!tagPattern.test(options.tag)) throw new Error(`invalid image tag: ${options.tag}`)
  if (!digestPattern.test(options.digest)) throw new Error(`invalid image digest: ${options.digest}`)
  if (Number.isNaN(Date.parse(options.rolloutTimestamp))) throw new Error('rollout timestamp must be ISO-8601')

  const kustomizationPath = options.kustomizationPath ?? 'argocd/applications/bayn/kustomization.yaml'
  const deploymentPath = options.deploymentPath ?? 'argocd/applications/bayn/deployment.yaml'
  const applicationSetPath = options.applicationSetPath ?? 'argocd/applicationsets/product.yaml'
  const kustomization = readFileSync(kustomizationPath, 'utf8')
  const imageBlock =
    /(  - name: registry\.ide-newton\.ts\.net\/lab\/bayn\n    newName: registry\.ide-newton\.ts\.net\/lab\/bayn\n    newTag: )[^\n]+(?:\n    digest: [^\n]+)?/
  const updatedKustomization = replaceExactlyOnce(
    kustomization,
    imageBlock,
    `$1${JSON.stringify(options.tag)}\n    digest: ${options.digest}`,
    'Bayn image block',
  )

  const deployment = readFileSync(deploymentPath, 'utf8')
  let updatedDeployment = replaceExactlyOnce(
    deployment,
    /(            - name: BAYN_CODE_REVISION\n              value: )[^\n]+/,
    `$1${options.sourceSha}`,
    'BAYN_CODE_REVISION value',
  )
  updatedDeployment = replaceExactlyOnce(
    updatedDeployment,
    /(            - name: BAYN_IMAGE_DIGEST\n              value: )[^\n]+/,
    `$1${options.digest}`,
    'BAYN_IMAGE_DIGEST value',
  )
  updatedDeployment = replaceExactlyOnce(
    updatedDeployment,
    /(        kubectl\.kubernetes\.io\/restartedAt: )[^\n]+/,
    `$1${JSON.stringify(options.rolloutTimestamp)}`,
    'Bayn rollout annotation',
  )

  const applicationSet = readFileSync(applicationSetPath, 'utf8')
  const updatedApplicationSet = replaceExactlyOnce(
    applicationSet,
    /(^ {14}- name: bayn\n(?:(?!^ {14}- name:)[\s\S])*?^ {16}enabled: )"(?:false|true)"/m,
    '$1"true"',
    'Bayn ApplicationSet enabled state',
  )

  writeFileSync(kustomizationPath, updatedKustomization)
  writeFileSync(deploymentPath, updatedDeployment)
  writeFileSync(applicationSetPath, updatedApplicationSet)
}

const parseArguments = (argumentsToParse: readonly string[]): UpdateBaynManifestOptions => {
  const values = new Map<string, string>()
  for (let index = 0; index < argumentsToParse.length; index += 2) {
    const flag = argumentsToParse[index]
    const value = argumentsToParse[index + 1]
    if (!flag?.startsWith('--') || value === undefined) throw new Error(`invalid argument near ${flag ?? '<end>'}`)
    values.set(flag, value)
  }
  const required = (flag: string): string => {
    const value = values.get(flag)?.trim()
    if (!value) throw new Error(`${flag} is required`)
    return value
  }
  return {
    sourceSha: required('--source-sha'),
    tag: required('--tag'),
    digest: required('--digest'),
    rolloutTimestamp: required('--rollout-timestamp'),
  }
}

if (import.meta.main) {
  try {
    updateBaynManifests(parseArguments(process.argv.slice(2)))
  } catch (cause) {
    console.error(cause instanceof Error ? cause.message : String(cause))
    process.exitCode = 1
  }
}
