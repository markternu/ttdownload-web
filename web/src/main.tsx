import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { BrowserRouter } from 'react-router-dom'
import App from './App'
import { AuthProvider } from './context/AuthContext'
import { ThemeProvider } from './context/ThemeContext'
import { ToastProvider } from './context/ToastContext'
import { APP_BASENAME } from './lib/basePath'
import './index.css'

const container = document.getElementById('root')
if (!container) {
  throw new Error('未找到 #root 挂载节点')
}

createRoot(container).render(
  <StrictMode>
    {/* basename 由当前地址推导：支持 nginx 子路径反代（如 /ttdownload/）而无需重新构建 */}
    <BrowserRouter basename={APP_BASENAME || undefined}>
      <ThemeProvider>
        <ToastProvider>
          {/* 登录状态在最外层：未登录时 App 只渲染登录页，业务数据 Provider 不挂载 */}
          <AuthProvider>
            <App />
          </AuthProvider>
        </ToastProvider>
      </ThemeProvider>
    </BrowserRouter>
  </StrictMode>,
)
