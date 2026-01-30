import { stdin, stdout } from 'node:process'
import { createInterface } from 'node:readline/promises'

export type PromptOptions = {
  defaultValue?: string
  allowEmpty?: boolean
}

export const promptText = async (question: string, options: PromptOptions = {}) => {
  const rl = createInterface({ input: stdin, output: stdout })
  const suffix = options.defaultValue ? ` (${options.defaultValue})` : ''
  const answer = await rl.question(`${question}${suffix}: `)
  rl.close()
  const value = answer.trim() || options.defaultValue || ''
  if (!options.allowEmpty && !value) {
    throw new Error('Input is required')
  }
  return value
}

export const promptConfirm = async (question: string, defaultValue = false) => {
  const rl = createInterface({ input: stdin, output: stdout })
  const hint = defaultValue ? 'Y/n' : 'y/N'
  const answer = await rl.question(`${question} (${hint}): `)
  rl.close()
  const trimmed = answer.trim().toLowerCase()
  if (!trimmed) return defaultValue
  return ['y', 'yes'].includes(trimmed)
}

export const promptList = async (question: string) => {
  const answer = await promptText(question, { allowEmpty: true })
  return answer
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean)
}
