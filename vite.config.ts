import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  // GitHub Pages（https://genzaburo-komoda.github.io/sekaiju-sim/）でも手元でも動くように、ファイルの場所を相対にする
  base: './',
  // 環境変数 PORT があればそのポートで起動する（他の開発サーバーとの衝突を避けるため）
  server: process.env.PORT ? { port: Number(process.env.PORT), strictPort: true } : undefined,
})
