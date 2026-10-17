// ブラウザへの保存（仕様書 A4）。
// 保存形式は共有コードと同じにして、読み込むときは URL と同じ検査を通す。
// プライベートブラウズなどで保存できない環境でも、アプリが止まらないようにすべて try/catch で包む。

const CURRENT_KEY = 'sekaiju-sim:current'
const SAVED_KEY = 'sekaiju-sim:saved'

export interface SavedBuild {
  name: string
  code: string
  savedAt: string
}

function read(key: string): string | null {
  try {
    return localStorage.getItem(key)
  } catch {
    return null
  }
}

function write(key: string, value: string): boolean {
  try {
    localStorage.setItem(key, value)
    return true
  } catch {
    return false
  }
}

/** 編集中のパーティ（自動保存）。次に開いたときに続きから始めるため */
export const loadCurrent = () => read(CURRENT_KEY)
export const saveCurrent = (code: string) => write(CURRENT_KEY, code)

/** 名前を付けて保存した構築の一覧 */
export function loadSaved(): SavedBuild[] {
  const text = read(SAVED_KEY)
  if (!text) return []
  try {
    const list = JSON.parse(text)
    return Array.isArray(list)
      ? list.filter((b): b is SavedBuild => typeof b?.name === 'string' && typeof b?.code === 'string' && typeof b?.savedAt === 'string')
      : []
  } catch {
    return []
  }
}

/** 同じ名前があれば上書きする。保存できなければ false */
export function saveBuild(name: string, code: string): boolean {
  const list = loadSaved().filter((b) => b.name !== name)
  list.unshift({ name, code, savedAt: new Date().toISOString() })
  return write(SAVED_KEY, JSON.stringify(list))
}

export function deleteBuild(name: string): boolean {
  return write(SAVED_KEY, JSON.stringify(loadSaved().filter((b) => b.name !== name)))
}
