#!/usr/bin/env bun

import { fatal } from '../shared/cli'
import { validateTengriRelease } from './release-manifests'

if (import.meta.main) {
  try {
    console.log(JSON.stringify(validateTengriRelease()))
  } catch (error) {
    fatal('Tengri release validation failed', error)
  }
}
