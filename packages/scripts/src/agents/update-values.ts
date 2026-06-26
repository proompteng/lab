#!/usr/bin/env bun

import { resolve } from 'node:path'
import process from 'node:process'

import { updateAgentsValuesFile } from './deploy-service'
import { fatal, repoRoot } from '../shared/cli'
import { execGit } from '../shared/git'

type Options = {
  valuesPath?: string
  tag?: string
  controllerRepository?: string
  controllerDigest?: string
  controlPlaneRepository?: string
  controlPlaneDigest?: string
  devShellRepository?: string
  devShellDigest?: string
  runnerRepository?: string
  runnerDigest?: string
  sourceSha?: string
  runId?: string
  ciConclusion?: string
}

const digestPattern = /^sha256:[0-9a-f]{64}$/i

const parseArgs = (argv: string[]): Options => {
  const options: Options = {}

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    const [flag, inlineValue] = arg.includes('=') ? arg.split(/=(.*)/s, 2) : [arg, undefined]
    const value = inlineValue ?? argv[i + 1]
    if (inlineValue === undefined) i += 1
    if (!flag.startsWith('--') || value === undefined) {
      throw new Error(`Invalid argument: ${arg}`)
    }

    switch (flag) {
      case '--values':
        options.valuesPath = value
        break
      case '--tag':
        options.tag = value
        break
      case '--controller-repository':
        options.controllerRepository = value
        break
      case '--controller-digest':
        options.controllerDigest = normalizeDigest(value)
        break
      case '--control-plane-repository':
        options.controlPlaneRepository = value
        break
      case '--control-plane-digest':
        options.controlPlaneDigest = normalizeDigest(value)
        break
      case '--dev-shell-repository':
        options.devShellRepository = value
        break
      case '--dev-shell-digest':
        options.devShellDigest = normalizeDigest(value)
        break
      case '--runner-repository':
        options.runnerRepository = value
        break
      case '--runner-digest':
        options.runnerDigest = normalizeDigest(value)
        break
      case '--source-sha':
        options.sourceSha = value
        break
      case '--run-id':
        options.runId = value
        break
      case '--ci-conclusion':
        options.ciConclusion = value
        break
      default:
        throw new Error(`Unknown option: ${flag}`)
    }
  }

  return options
}

const normalizeDigest = (value: string): string => {
  const trimmed = value.trim()
  return trimmed.includes('@') ? trimmed.slice(trimmed.lastIndexOf('@') + 1) : trimmed
}

const requireValue = (options: Options, key: keyof Options): string => {
  const value = options[key]
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new Error(`Missing required option --${key.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`)}`)
  }
  return value
}

const requireDigest = (options: Options, key: keyof Options): string => {
  const digest = requireValue(options, key)
  if (!digestPattern.test(digest)) {
    throw new Error(`Invalid digest for ${key}: ${digest}`)
  }
  return digest
}

export const updateAgentsValuesFromCliOptions = (options: Options) => {
  const valuesPath = resolve(repoRoot, options.valuesPath ?? 'argocd/applications/agents/values.yaml')
  const tag = requireValue(options, 'tag')
  const sourceSha = options.sourceSha ?? execGit(['rev-parse', 'HEAD'])
  const controlPlaneDigest = requireDigest(options, 'controlPlaneDigest')

  updateAgentsValuesFile(
    valuesPath,
    requireValue(options, 'controllerRepository'),
    tag,
    requireDigest(options, 'controllerDigest'),
    requireValue(options, 'controlPlaneRepository'),
    tag,
    controlPlaneDigest,
    requireValue(options, 'runnerRepository'),
    tag,
    requireDigest(options, 'runnerDigest'),
    {
      sourceHeadSha: sourceSha,
      gitopsRevision: sourceSha,
      sourceCiRunId: options.runId ?? process.env.GITHUB_RUN_ID,
      sourceCiConclusion: options.ciConclusion ?? process.env.AGENTS_SOURCE_CI_CONCLUSION ?? 'success',
      manifestImageDigest: controlPlaneDigest,
      servingBuildCommit: sourceSha,
      servingImageDigest: controlPlaneDigest,
    },
    options.devShellRepository || options.devShellDigest
      ? {
          repository: requireValue(options, 'devShellRepository'),
          tag,
          digest: requireDigest(options, 'devShellDigest'),
        }
      : null,
  )
}

if (import.meta.main) {
  try {
    updateAgentsValuesFromCliOptions(parseArgs(process.argv.slice(2)))
  } catch (error) {
    fatal('Failed to update Agents values', error)
  }
}

export const __private = {
  normalizeDigest,
  parseArgs,
  requireDigest,
}
