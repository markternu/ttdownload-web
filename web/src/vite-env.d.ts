/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** 后端 API 前缀；同源部署时留空，例如 VITE_API_BASE=http://192.168.1.10:8080 */
  readonly VITE_API_BASE?: string
}

interface ImportMeta {
  readonly env: ImportMetaEnv
}
