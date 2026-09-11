import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { BrowserRouter } from 'react-router-dom'
import App from './App'
import { AppDataProvider, SettingsProvider } from './context/AppDataContext'
import { ThemeProvider } from './context/ThemeContext'
import { ToastProvider } from './context/ToastContext'
import './index.css'

const container = document.getElementById('root')
if (!container) {
  throw new Error('未找到 #root 挂载节点')
}

createRoot(container).render(
  <StrictMode>
    <BrowserRouter>
      <ThemeProvider>
        <ToastProvider>
          <SettingsProvider>
            <AppDataProvider>
              <App />
            </AppDataProvider>
          </SettingsProvider>
        </ToastProvider>
      </ThemeProvider>
    </BrowserRouter>
  </StrictMode>,
)
