import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  // GitHub Pages（https://genzaburo-komoda.github.io/sekaiju-sim/）でも手元でも動くように、ファイルの場所を相対にする
  base: './',
  // 開発サーバー：既定のポートは 5180（5173 は別の開発サーバーが使うため）。環境変数 PORT があればそれを使う。
  // host: true は IPv4 でも待ち受けるため（既定だと [::1] だけになり、Dev Container のポート転送でつながらない）
  server: { port: Number(process.env.PORT ?? 5180), strictPort: true, host: true },
})
