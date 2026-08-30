#!/usr/bin/env bun

import { readFileSync } from 'node:fs'

import { fatal } from '../shared/cli'
import { assertRenderedTengriWorkload, validateTengriRelease } from './release-manifests'

if (import.meta.main) {
  try {
    const release = validateTengriRelease()
    assertRenderedTengriWorkload(readFileSync(0, 'utf8'), release)
    console.log(JSON.stringify(release))
  } catch (error) {
    fatal('Rendered Tengri release validation failed', error)
  }
}
