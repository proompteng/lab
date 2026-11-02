import * as React from 'react'
import { createRoot } from 'react-dom/client'
import { RouterProvider } from '@tanstack/react-router'

import { getRouter } from './router'
import './styles.css'

const container = document.getElementById('root')

if (!container) {
  throw new Error('Missing #root mount for Jangar client.')
}

const router = getRouter()
const root = createRoot(container)

root.render(
  <React.StrictMode>
    <RouterProvider router={router} />
  </React.StrictMode>,
)
