import { defineApplication } from '../../application'

import { AnalysisChart } from './chart'

export const analysisApplication = defineApplication({
  name: 'analysis',
  namespace: 'analysis',
  outputDir: 'argocd/applications/analysis/generated',
  create(scope) {
    return new AnalysisChart(scope, 'analysis', { namespace: 'analysis' })
  },
})
