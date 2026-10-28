// 画面全体。左に縦メニュー・パーティ一覧・保存・共有、右にメニューで選んだ画面を置く（スマホでは縦に並ぶ）。
// 縦メニュー（開発計画 U12、2026-10-28 本人決定）：編成・スキル／ダメージ計算／採点・プラン／戦闘。
// 画面を切り替えても入力や結果が消えないように、選んでいない画面も作ったまま隠しておく
import { useEffect, useState } from 'react'
import { BattlePanel } from './components/BattlePanel'
import { DamagePanel } from './components/DamagePanel'
import { HelpPanel } from './components/HelpPanel'
import { LevelPlanPanel } from './components/LevelPlanPanel'
import { MemberEditor } from './components/MemberEditor'
import { PartyPanel } from './components/PartyPanel'
import { ScorePanel } from './components/ScorePanel'
import { ShareTools } from './components/ShareTools'
import { Welcome } from './components/Welcome'
import { equipment, jobs, rules, skillsByJob } from './data/gameData'
import { MAX_MEMBERS, newMember, removeError, type Member, type Party } from './logic/party'
import { ISSUES_URL } from './links'
import { sampleParty } from './logic/sample'
import { decodeParty, encodeParty } from './logic/share'
import { loadCurrent, saveCurrent } from './logic/storage'

const firstJob = jobs[0].id

type View = 'build' | 'damage' | 'score' | 'battle'
const VIEWS: { id: View; label: string }[] = [
  { id: 'build', label: '編成・スキル' },
  { id: 'damage', label: 'ダメージ計算' },
  { id: 'score', label: '採点・プラン' },
  { id: 'battle', label: '戦闘シミュレーション' },
]

// 選んでいた画面・敵・「はじめに」を閉じたかは、このブラウザに覚えておく（読み書きできなくても動く）
const VIEW_KEY = 'sekaiju-sim:view'
const ENEMY_KEY = 'sekaiju-sim:enemy'
const WELCOME_KEY = 'sekaiju-sim:welcome-closed'
function load(key: string): string | null {
  try {
    return localStorage.getItem(key)
  } catch {
    return null
  }
}
function store(key: string, value: string | null) {
  try {
    if (value === null) localStorage.removeItem(key)
    else localStorage.setItem(key, value)
  } catch {
    // 保存できなくても使える
  }
}
const ctx = { jobs, skillsByJob, rules, equipment }

/** 画面上部に出すお知らせ（読み込みの結果など） */
interface Notice {
  kind: 'info' | 'error'
  lines: string[]
}

/**
 * 起動時のパーティ：
 * 1. URL の「#」以降に共有コードがあればそれを開く
 * 2. なければ前回編集していたパーティ（自動保存）
 * 3. どちらもなければ新規
 */
function initialState(): { party: Party; notice: Notice | null } {
  const fresh: Party = { difficulty: 'expert', members: [newMember([], firstJob)] }
  const hash = decodeURIComponent(location.hash.slice(1))
  if (hash) {
    // 読み込んだあとは URL から共有コードを消す（以後の編集と URL の中身が食い違わないように）
    history.replaceState(null, '', location.pathname + location.search)
    const r = decodeParty(hash, ctx)
    if (r.ok) return { party: r.party, notice: { kind: 'info', lines: ['共有された構築を読み込みました', ...r.warnings] } }
    return { party: fresh, notice: { kind: 'error', lines: [`共有された構築を読み込めませんでした：${r.error}`] } }
  }
  const saved = loadCurrent()
  if (saved) {
    const r = decodeParty(saved, ctx)
    if (r.ok) return { party: r.party, notice: r.warnings.length ? { kind: 'info', lines: ['前回の続きを読み込みました', ...r.warnings] } : null }
  }
  return { party: fresh, notice: null }
}

function App() {
  const [initial] = useState(initialState)
  const [party, setParty] = useState<Party>(initial.party)
  const [notice, setNotice] = useState<Notice | null>(initial.notice)
  const [selectedId, setSelectedId] = useState(initial.party.members[0].id)
  const selected = party.members.find((m) => m.id === selectedId) ?? party.members[0]
  const [showHelp, setShowHelp] = useState(false)
  const [view, setView] = useState<View>(() => (VIEWS.find((v) => v.id === load(VIEW_KEY))?.id ?? 'build'))
  // 敵の選択はダメージ計算と戦闘シミュレーションで共通（開発計画 U10）
  const [enemyId, setEnemyId] = useState<string | null>(() => load(ENEMY_KEY))
  const [showWelcome, setShowWelcome] = useState(() => load(WELCOME_KEY) === null)

  useEffect(() => store(VIEW_KEY, view), [view])
  useEffect(() => store(ENEMY_KEY, enemyId), [enemyId])

  const closeWelcome = () => {
    setShowWelcome(false)
    store(WELCOME_KEY, '1')
  }
  const loadSample = () => {
    // 編集中のパーティ（2人以上か、スキルを振った人がいる）は消えてしまうので、確かめてから入れ替える
    const editing = party.members.length > 1 || party.members.some((m) => Object.keys(m.skills).length > 0)
    if (editing && !window.confirm('今のパーティをサンプルの編成に入れ替えます。よろしいですか？（今のパーティは「保存」していなければ消えます）')) return
    const members = sampleParty(party.difficulty)
    setParty({ ...party, members })
    setSelectedId(members[0].id)
    setNotice({ kind: 'info', lines: ['サンプルの編成（Lv70 の5人）を読み込みました。スキルと装備は自動で選んだ例で、役割に効くスキルだけを振っているので SP が残ります'] })
    closeWelcome()
  }
  const applySkills = (memberId: string, skills: Member['skills']) =>
    setParty((p) => ({ ...p, members: p.members.map((m) => (m.id === memberId ? { ...m, skills } : m)) }))

  // 編集のたびに自動保存（次に開いたときに続きから始められるように）
  useEffect(() => {
    saveCurrent(encodeParty(party))
  }, [party])

  // 共有コードを読み込む（保存した構築の読み込みと、開いたまま別の共有 URL を貼られたとき）
  const loadCode = (code: string, source: string) => {
    const r = decodeParty(code, ctx)
    if (!r.ok) {
      setNotice({ kind: 'error', lines: [`${source}を読み込めませんでした：${r.error}`] })
      return
    }
    setParty(r.party)
    setSelectedId(r.party.members[0].id)
    setNotice({ kind: 'info', lines: [`${source}を読み込みました`, ...r.warnings] })
  }

  useEffect(() => {
    const onHash = () => {
      const hash = decodeURIComponent(location.hash.slice(1))
      if (!hash) return
      history.replaceState(null, '', location.pathname + location.search)
      loadCode(hash, '共有された構築')
    }
    window.addEventListener('hashchange', onHash)
    return () => window.removeEventListener('hashchange', onHash)
  })

  const updateMember = (next: Member) =>
    setParty((p) => ({ ...p, members: p.members.map((m) => (m.id === next.id ? next : m)) }))

  const addMember = () => {
    if (party.members.length >= MAX_MEMBERS) return
    const m = newMember(party.members, firstJob)
    setParty({ ...party, members: [...party.members, m] })
    setSelectedId(m.id)
  }

  const removeMember = (id: string) => {
    if (removeError(party.members, id)) return
    const members = party.members.filter((m) => m.id !== id)
    setParty({ ...party, members })
    if (id === selectedId) setSelectedId(members[0].id)
  }

  return (
    <div className="page">
      <header className="header">
        <h1>世界樹の迷宮Ⅰ HD REMASTER パーティ構築シミュレーター</h1>
        <p className="subtitle">
          非公式ファンツール（β版）
          <button type="button" className="help-button" onClick={() => setShowHelp(!showHelp)} aria-expanded={showHelp}>
            使い方・免責
          </button>
        </p>
      </header>

      {showHelp && <HelpPanel onClose={() => setShowHelp(false)} />}

      {notice && (
        <div className={`notice ${notice.kind}`} role={notice.kind === 'error' ? 'alert' : 'status'}>
          <ul>{notice.lines.map((l, i) => <li key={i}>{l}</li>)}</ul>
          <button type="button" onClick={() => setNotice(null)} aria-label="お知らせを閉じる">×</button>
        </div>
      )}

      <main className="main layout">
        <div className="side">
          <nav className="view-menu" aria-label="画面の切り替え">
            {VIEWS.map((v) => (
              <button key={v.id} type="button" aria-pressed={view === v.id} onClick={() => setView(v.id)}>
                {v.label}
              </button>
            ))}
          </nav>
          <PartyPanel
            party={party}
            selectedId={selected.id}
            onSelect={setSelectedId}
            onAdd={addMember}
            onRemove={removeMember}
            onDifficulty={(difficulty) => setParty((p) => ({ ...p, difficulty }))}
          />
          <ShareTools party={party} ctx={ctx} onLoadCode={(code) => loadCode(code, '保存した構築')} />
        </div>

        <div className="views">
          {showWelcome && <Welcome onSample={loadSample} onClose={closeWelcome} onGoDamage={() => setView('damage')} />}

          <div hidden={view !== 'build'}>
            <MemberEditor member={selected} members={party.members} onChange={updateMember} />
          </div>

          <div hidden={view !== 'damage'} className="view-card">
            <DamagePanel
              member={selected}
              members={party.members}
              difficulty={party.difficulty}
              onApplySkills={(skills) => applySkills(selected.id, skills)}
              enemyId={enemyId}
              onEnemyChange={setEnemyId}
            />
          </div>

          <div hidden={view !== 'score'}>
            <ScorePanel party={party} selectedId={selected.id} onApply={applySkills} />
            <LevelPlanPanel party={party} member={selected} />
          </div>

          <div hidden={view !== 'battle'}>
            <BattlePanel
              party={party}
              onApplyParty={(members) => {
                setParty((p) => ({ ...p, members }))
                setNotice({ kind: 'info', lines: ['探した編成をパーティに当てはめました'] })
              }}
              enemyId={enemyId}
              onEnemyChange={setEnemyId}
            />
          </div>
        </div>
      </main>

      {/* 仕様書11章：全画面に非公式である旨と権利表記を出す */}
      <footer className="footer">
        <p>
          本ツールは非公式のファンツールであり、株式会社アトラスおよび株式会社セガとは一切関係ありません。
        </p>
        <p>『世界樹の迷宮』に関する著作権その他の権利は、各権利者に帰属します。</p>
        <p>数値の多くは資料（DS版の記述や解析を含む）にもとづく未検証の値です。計算結果の正確さは保証しません。</p>
        <p>
          誤りの報告・実測値の提供：<a href={ISSUES_URL} target="_blank" rel="noreferrer">GitHub の Issue</a>
          ／ソースコードは MIT ライセンス
        </p>
      </footer>
    </div>
  )
}

export default App
