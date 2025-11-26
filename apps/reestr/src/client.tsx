import { StartClient } from '@tanstack/react-start/client'
import { hydrateRoot } from 'react-dom/client'

import { createRouter } from './router'

const router = createRouter()

const rootElement = document.getElementById('root')

if (!rootElement) {
  throw new Error('Root element not found')
}

hydrateRoot(rootElement, <StartClient router={router} />)
