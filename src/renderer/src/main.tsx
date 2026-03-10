import React from 'react'
import ReactDOM from 'react-dom/client'
import { App } from './App'
import type { Api } from '../../preload/index'

declare global {
  interface Window {
    api: Api
  }
}

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
)
