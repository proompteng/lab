import process from 'node:process'

import { runCandidateDevelopmentLocalMain } from '../../../../../services/bayn/src/candidate-development-local/command'

if (import.meta.main) runCandidateDevelopmentLocalMain(process.argv.slice(2))
