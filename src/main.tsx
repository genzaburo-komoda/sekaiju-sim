import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
// 文字（2026-11-01 本人の依頼で選び直した。どちらも OFL-1.1。アプリの中に入れて配り、外のサーバーから読み込まない）
// - 英字・数字：Libertinus Sans。ゲームの英字の見出し（OPTION など）と同じく、線の端が少し広がる書体
// - 日本語：BIZ UDPGothic。ゲームの日本語のように、かなの幅が詰まった太いゴシック。読みやすさを重視した書体
// Libertinus Sans は大きさを日本語に合わせるため、index.css で自前の @font-face（size-adjust）として読み込む
import '@fontsource/biz-udpgothic/400.css'
import '@fontsource/biz-udpgothic/700.css'
import './index.css'
import App from './App.tsx'

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
