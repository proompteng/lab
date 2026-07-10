import { defineApplication } from '../../application'

import { DocsChart } from './chart'

export const docsApplication = defineApplication({
  name: 'docs',
  namespace: 'docs',
  outputDir: 'argocd/applications/docs/generated',
  create(scope) {
    return new DocsChart(scope, 'docs', { namespace: 'docs' })
  },
})
