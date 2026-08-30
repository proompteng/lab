import { Codex } from '../src/index'

const main = async () => {
  const codex = new Codex()
  const thread = codex.startThread({
    workingDirectory: process.cwd(),
    approvalPolicy: 'never',
  })

  console.log('Starting Codex example...')
  const { finalResponse } = await thread.run('Summarize this repository in one sentence.')
  console.log('Codex response:', finalResponse)
}

main().catch((error) => {
  console.error('Example failed:', error)
  process.exit(1)
})
