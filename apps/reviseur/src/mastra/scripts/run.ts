import { githubAgent } from '../agents/github.js'

const run = async () => {
  const result = await githubAgent.generate([
    {
      role: 'user',
      content: 'Review the PR https://github.com/proompteng/lab/pull/723',
    },
  ])
  console.log(result)
}

run().then(() => {
  console.log('Done')
  process.exit(0)
})
