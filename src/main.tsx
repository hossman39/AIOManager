import './lib/polyfill'
import { StrictMode } from 'react'
import ReactDOM from 'react-dom/client'

import { createBrowserRouter, RouterProvider } from 'react-router-dom'
import { ThemeProvider } from './contexts/ThemeContext'
import { ErrorBoundary } from './components/common/ErrorBoundary'
import { UnsavedWorkGuard } from './components/common/UnsavedWorkGuard'
import App from './App.tsx'
import './index.css'

// Keep the existing descendant Routes/auth boundary; enable reliable navigation blocking.
const router = createBrowserRouter([
  {
    path: '*',
    element: (
      <ThemeProvider>
        <ErrorBoundary>
          <UnsavedWorkGuard>
            <App />
          </UnsavedWorkGuard>
        </ErrorBoundary>
      </ThemeProvider>
    ),
  },
])

ReactDOM.createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <RouterProvider router={router} />
  </StrictMode>
)
