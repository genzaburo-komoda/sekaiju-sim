// レベル進行プラン（B7）と条件付き最適化・編成の探索（B10）のテスト（開発計画 5-1・5-2 の完了条件）
import { describe, expect, it } from 'vitest'
import { enemies, jobs, rules } from '../data/gameData'
import { levelPlan, planText } from './levelplan'
import { newMember, type Member } from './party'
import { buildsFor, DEFAULT_CONDITIONS, evaluateParty, missingSkills, rowAssignments, searchParty, strongestArmor } from './partysearch'
import { targetFromEnemy } from './predict'
import { defaultRole, memberOptimum } from './score'
import type { BattleSetup, EnemyAction } from './sim'
import { spTotal, spUsed } from './skills'

const settings = { difficulty: 'expert' as const, target: null, partySize: 5 }

describe('レベル進行プラン（B7、5-1 の完了条件）', () => {
  it.each(jobs.map((j) => j.id))('%s：Lv1〜70 の振り順が出る（スキルは下げない、SP を超えない）', (jobId) => {
    const role = defaultRole(jobId)
    const m: Member = { ...newMember([], jobId), level: 70 }
    const plan = levelPlan(m, role === 'support' ? 'damage' : role, null, 70, settings)
    expect(plan.error).toBeNull()
    expect(plan.steps.map((s) => s.level)).toEqual(Array.from({ length: 70 }, (_, i) => i + 1))
    let prev = {}
    for (const st of plan.steps) {
      expect(spUsed(st.alloc)).toBeLessThanOrEqual(spTotal(rules, st.level))
      for (const [id, lv] of Object.entries(prev)) expect(st.alloc[id] ?? 0).toBeGreaterThanOrEqual(lv as number)
      prev = st.alloc
    }
  })

  it('メディック Lv1（SP3）：キュア1（前提の回復マスタリー1 と合わせて 2SP、回復量 18）を先に取り、残りの1SP でキュア2（24）', () => {
    const m: Member = { ...newMember([], 'medic'), level: 1 }
    const plan = levelPlan(m, 'heal', null, 1, settings)
    expect(plan.steps[0].alloc).toEqual({ 'medic-heal-mastery': 1, 'medic-cure': 2 })
    expect(plan.steps[0].value).toBe(24)
  })

  it('目標あり：途中の振り方はすべて目標の一部で、最後は目標と同じ（振り直し不要）', () => {
    const m: Member = { ...newMember([], 'swordsman'), level: 30, weaponId: 'sword-4' }
    const target = memberOptimum(m, 'damage', settings).alloc
    const plan = levelPlan(m, 'damage', target, 30, settings)
    for (const st of plan.steps) for (const [id, lv] of Object.entries(st.alloc)) expect(lv).toBeLessThanOrEqual(target[id] ?? 0)
    expect(plan.steps.at(-1)!.alloc).toEqual(target)
    expect(planText('ソードマン', plan)).toContain('Lv1：')
  })

  it('目標の SP が足りなければ理由を返す', () => {
    const m: Member = { ...newMember([], 'swordsman'), level: 5 }
    expect(levelPlan(m, 'damage', { 'raging-edge': 10, 'sword-mastery': 10 }, 5, settings).error).toContain('足りません')
  })
})

describe('条件付き最適化・編成の探索（B10、5-2 の完了条件）', () => {
  const foe = enemies.find((e) => e.kind === 'foe' && e.level >= 18 && e.level <= 25)!
  const normal: EnemyAction = { name: '通常攻撃', attack: 'str', element: 'bash', power: 100, target: 'single', weight: 1, accuracy: foe.accuracy, normal: true }
  const slots = (n: number): Member[] => Array.from({ length: n }, (_, i) => ({ ...newMember([], 'swordsman'), name: `枠${i + 1}`, level: 20, row: i < 3 ? 'front' : 'back' }))
  const setupOf = (members: Member[]): BattleSetup => ({ members, difficulty: 'expert', enemy: foe, target: targetFromEnemy(foe), manual: { hp: 1, str: 0, tec: 0, agi: 0 }, enemyActions: [normal] })
  const cond = { ...DEFAULT_CONDITIONS, trials: 100 }

  it('探す枠が1つなら、全部の候補（ジョブ×振り方）を評価した最良と一致する', () => {
    const members = slots(3)
    const setup = setupOf(members)
    const r = searchParty(setup, { ...cond, noDuplicateJobs: false, searchRows: false, fixed: [true, true, false] })
    let best = -1
    for (const j of jobs) {
      for (const b of buildsFor(members[2], j.id, setup, [])) {
        const m = { ...members[2], jobId: j.id, skills: b.alloc, weaponId: b.weaponId, armorIds: strongestArmor(j.id), retire: null }
        best = Math.max(best, evaluateParty(setup, [members[0], members[1], m], ['fixed', 'fixed', b.kind], cond).score)
      }
    }
    expect(r.best[0].score).toBeCloseTo(best)
  })

  it('5人すべてを探しても1分以内に終わり、条件（重複なし・除外・必須スキル）を守る', () => {
    const t0 = performance.now()
    const r = searchParty(setupOf(slots(5)), { ...cond, fixed: [false, false, false, false, false], excludedJobs: ['swordsman'], requiredSkills: ['ranger-mining'] })
    expect(performance.now() - t0).toBeLessThan(60000)
    expect(r.error).toBeNull()
    for (const p of r.best) {
      const ids = p.members.map((m) => m.jobId)
      expect(new Set(ids).size).toBe(5)
      expect(ids).not.toContain('swordsman')
      expect(missingSkills(p.members, ['ranger-mining'])).toEqual([])
    }
    for (let i = 1; i < r.best.length; i++) expect(r.best[i].score).toBeLessThanOrEqual(r.best[i - 1].score)
  }, 120000)

  it('固定したメンバーはそのまま残る', () => {
    const members = slots(2)
    const fixed = { ...members[0], jobId: 'medic', skills: { 'medic-heal-mastery': 1, 'medic-cure': 3 } }
    const r = searchParty(setupOf([fixed, members[1]]), { ...cond, fixed: [true, false] })
    expect(r.best[0].members[0]).toEqual(fixed)
    expect(r.best[0].kinds[0]).toBe('fixed')
  })

  it('隊列の並べ方：前列1〜3人・後列0〜3人を守り、固定の枠は動かさない', () => {
    const members = slots(5)
    const all = rowAssignments(members, [false, false, false, false, false])
    // 5人：前列1人だと後列4人で不可。前列2人 10通り＋前列3人 10通り
    expect(all.length).toBe(20)
    const fixedFront = rowAssignments(members, [true, false, false, false, false])
    for (const rows of fixedFront) expect(rows[0]).toBe(members[0].row)
  })

  it('隊列も探すと、隊列を固定したときより点数が下がらず、結果は隊列の決まりを守る（2026-11-01）', () => {
    const setup = setupOf(slots(4))
    const base = searchParty(setup, { ...cond, searchRows: false, fixed: [false, false, false, false] })
    const rows = searchParty(setup, { ...cond, searchRows: true, fixed: [false, false, false, false] })
    expect(rows.best[0].score).toBeGreaterThanOrEqual(base.best[0].score - 1e-9)
    for (const p of rows.best) {
      const front = p.members.filter((m) => m.row === 'front').length
      expect(front).toBeGreaterThanOrEqual(1)
      expect(front).toBeLessThanOrEqual(3)
      expect(p.members.length - front).toBeLessThanOrEqual(3)
    }
  }, 120000)

  it('余った火力：同じ編成なら、ソードマンが前列のほうが後列より撃破の点が高い（2026-11-01）', () => {
    const [a, b] = slots(2)
    const sword = { ...b, skills: {}, weaponId: 'sword-4' }
    const front = evaluateParty(setupOf([a, { ...sword, row: 'front' }]), [a, { ...sword, row: 'front' }], ['damage', 'damage'], cond)
    const back = evaluateParty(setupOf([a, { ...sword, row: 'back' }]), [a, { ...sword, row: 'back' }], ['damage', 'damage'], cond)
    expect(front.killScore).toBeGreaterThan(back.killScore)
  })

  it('撃破の点は 1 を超えない', () => {
    const r = searchParty(setupOf(slots(2)), { ...cond, fixed: [false, false] })
    for (const p of r.best) expect(p.killScore).toBeLessThanOrEqual(1)
  })

  it('必須のジョブ：カースメーカー・ブシドーを必須にすると、結果のすべての編成に入る（2026-11-01）', () => {
    const r = searchParty(setupOf(slots(5)), { ...cond, fixed: [false, false, false, false, false], requiredJobs: ['hexer', 'bushido'] })
    expect(r.error).toBeNull()
    expect(r.best.length).toBeGreaterThan(0)
    for (const p of r.best) {
      const ids = p.members.map((m) => m.jobId)
      expect(ids).toContain('hexer')
      expect(ids).toContain('bushido')
    }
  }, 120000)

  it('必須のジョブ：5つ必須なら5つとも入る。固定の枠より多い・除外と重なる・6つ以上は理由を返す', () => {
    const five = ['hexer', 'bushido', 'ranger', 'dark-hunter', 'bard']
    const r = searchParty(setupOf(slots(5)), { ...cond, fixed: [false, false, false, false, false], requiredJobs: five })
    expect(r.error).toBeNull()
    for (const p of r.best) expect(p.members.map((m) => m.jobId).sort()).toEqual([...five].sort())
    expect(searchParty(setupOf(slots(2)), { ...cond, fixed: [true, false], requiredJobs: ['hexer', 'bushido'] }).error).toMatch(/固定していない枠/)
    expect(searchParty(setupOf(slots(2)), { ...cond, fixed: [false, false], requiredJobs: ['hexer'], excludedJobs: ['hexer'] }).error).toMatch(/両方/)
    expect(searchParty(setupOf(slots(5)), { ...cond, fixed: [false, false, false, false, false], requiredJobs: [...five, 'medic'] }).error).toMatch(/5つまで/)
  }, 120000)

  it('条件を満たせないときは理由を返す', () => {
    const r = searchParty(setupOf(slots(2)), { ...cond, fixed: [false, false], excludedJobs: jobs.map((j) => j.id).filter((j) => j !== 'medic') })
    expect(r.error).toContain('条件を満たす編成がありません')
  })
})
