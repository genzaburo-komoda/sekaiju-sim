// データの検査。
// 1. 形式の検査：schema.ts の定義どおりか（型・必須項目・値の範囲）
// 2. 整合性の検査：ファイルをまたいだ矛盾がないか（存在しない前提スキル、レベル数の不一致など）
// 返り値はエラーメッセージの配列。空ならデータに問題なし。
import { z } from 'zod'
import { EnemyFile, EquipmentFile, FormulaSet, Job, ProgressionRules, SkillFile, type Skill, type SkillEffect } from './schema'

export interface DataSet {
  jobs: unknown[]
  skillFiles: unknown[]
  formulaSets?: unknown[]
  /** 成長の規則（1件） */
  rules?: unknown
  /** 装備（1ファイル） */
  equipment?: unknown
  /** 敵（1ファイル） */
  enemies?: unknown
}

/** 形式の検査。問題があればメッセージを errors に足し、合格したデータだけ返す */
function parseAll<T extends z.ZodType>(schema: T, items: unknown[], label: string, errors: string[]): z.infer<T>[] {
  const ok: z.infer<T>[] = []
  items.forEach((item, i) => {
    const r = schema.safeParse(item)
    if (r.success) ok.push(r.data)
    else for (const issue of r.error.issues) errors.push(`${label}[${i}] ${issue.path.join('.')}: ${issue.message}`)
  })
  return ok
}

/** 効果が参照している項目 ID を集める（powerParam など名前が Param で終わるもの） */
function referencedParams(effect: SkillEffect): string[] {
  const ids: string[] = []
  for (const [key, value] of Object.entries(effect)) {
    if (key.endsWith('Param') && typeof value === 'string') ids.push(value)
  }
  if (effect.type === 'buff' || effect.type === 'debuff') ids.push(...effect.modifiers.map((m) => m.param))
  if (effect.type === 'passive-stat') ids.push(effect.param)
  return ids
}

function checkSkill(skill: Skill, where: string, errors: string[]) {
  const paramIds = skill.params.map((p) => p.id)
  const dup = paramIds.filter((id, i) => paramIds.indexOf(id) !== i)
  if (dup.length) errors.push(`${where}: 項目 ID が重複しています（${[...new Set(dup)].join(', ')}）`)

  // 効果・速度が参照する項目が定義されているか
  const refs = skill.effects.flatMap(referencedParams)
  if (skill.speed.kind === 'agi-by-level') refs.push(skill.speed.paramId)
  for (const ref of refs) {
    if (!paramIds.includes(ref)) errors.push(`${where}: 効果が参照する項目「${ref}」が params に定義されていません`)
  }

  if (skill.status === 'skeleton') {
    if (skill.levels) errors.push(`${where}: status が skeleton なのに levels があります（入力済みなら entered にする）`)
    return
  }

  // 数値入力済みのスキル
  if (!skill.levels) {
    errors.push(`${where}: status が entered なのに levels がありません`)
    return
  }
  if (skill.levels.length !== skill.maxLevel) {
    errors.push(`${where}: levels の数（${skill.levels.length}）が最大レベル（${skill.maxLevel}）と一致しません`)
  }
  skill.levels.forEach((lv, i) => checkLevel(skill, lv, i + 1, paramIds, `${where} Lv${i + 1}`, errors))

  if (skill.boostLevels) {
    if (!skill.boostable) errors.push(`${where}: boostable が false なのに boostLevels があります`)
    if (skill.boostLevels.length !== 5) errors.push(`${where}: boostLevels は5レベル分必要です（現在 ${skill.boostLevels.length}）`)
    skill.boostLevels.forEach((lv, i) =>
      checkLevel(skill, lv, skill.maxLevel + i + 1, paramIds, `${where} BOOST Lv${skill.maxLevel + i + 1}`, errors),
    )
  }
}

function checkLevel(
  skill: Skill,
  lv: NonNullable<Skill['levels']>[number],
  expectedLv: number,
  paramIds: string[],
  where: string,
  errors: string[],
) {
  if (lv.lv !== expectedLv) errors.push(`${where}: lv が ${lv.lv} になっています（${expectedLv} のはず）`)
  const keys = Object.keys(lv.values)
  for (const id of paramIds) if (!keys.includes(id)) errors.push(`${where}: 項目「${id}」の値がありません`)
  for (const key of keys) if (!paramIds.includes(key)) errors.push(`${where}: 定義されていない項目「${key}」があります`)
  if (skill.category === 'active' && lv.tp === undefined) errors.push(`${where}: アクティブスキルなのに消費TPがありません`)
  if (skill.category !== 'active' && lv.tp !== undefined) errors.push(`${where}: アクティブスキル以外に消費TPがあります`)
}

/** 前提スキルのつながりを検査する（存在・同じジョブ・レベル上限・循環） */
function checkPrerequisites(skills: Skill[], errors: string[]) {
  const byId = new Map(skills.map((s) => [s.id, s]))
  for (const skill of skills) {
    for (const pre of skill.prerequisites) {
      const target = byId.get(pre.skillId)
      if (!target) {
        errors.push(`スキル ${skill.id}: 前提スキル「${pre.skillId}」が存在しません`)
        continue
      }
      if (target.id === skill.id) errors.push(`スキル ${skill.id}: 自分自身を前提にしています`)
      if (target.jobId !== skill.jobId) errors.push(`スキル ${skill.id}: 前提スキル「${pre.skillId}」が別のジョブのスキルです`)
      if (pre.level > target.maxLevel) {
        errors.push(`スキル ${skill.id}: 前提「${pre.skillId} Lv${pre.level}」が最大レベル ${target.maxLevel} を超えています`)
      }
    }
  }
  // 循環（A の前提が B、B の前提が A など）
  const state = new Map<string, 'visiting' | 'done'>()
  const visit = (id: string, path: string[]) => {
    if (state.get(id) === 'done') return
    if (state.get(id) === 'visiting') {
      errors.push(`前提スキルが循環しています：${[...path, id].join(' → ')}`)
      return
    }
    state.set(id, 'visiting')
    for (const pre of byId.get(id)?.prerequisites ?? []) if (byId.has(pre.skillId)) visit(pre.skillId, [...path, id])
    state.set(id, 'done')
  }
  for (const s of skills) visit(s.id, [])
}

export function validateData(data: DataSet): string[] {
  const errors: string[] = []
  const jobs = parseAll(Job, data.jobs, 'ジョブ', errors)
  const skillFiles = parseAll(SkillFile, data.skillFiles, 'スキルファイル', errors)
  const formulaSets = parseAll(FormulaSet, data.formulaSets ?? [], '式セット', errors)
  const [rules] = parseAll(ProgressionRules, data.rules === undefined ? [] : [data.rules], '成長の規則', errors)

  // 引退ボーナスの表：範囲が重ならず、レベル上限の中に収まっているか
  if (rules) {
    for (const [label, table] of [['SP', rules.retireSpBonus], ['ステータス', rules.retireStatBonus]] as const) {
      const sorted = [...table].sort((a, b) => a.minLevel - b.minLevel)
      sorted.forEach((row, i) => {
        if (row.minLevel > row.maxLevel) errors.push(`成長の規則：引退${label}ボーナスの範囲 ${row.minLevel}〜${row.maxLevel} が逆です`)
        if (row.maxLevel > rules.maxLevel) errors.push(`成長の規則：引退${label}ボーナスの範囲がレベル上限 ${rules.maxLevel} を超えています`)
        if (row.minLevel < rules.retireMinLevel) errors.push(`成長の規則：引退${label}ボーナスが引退できるレベル（${rules.retireMinLevel}）より下にあります`)
        const next = sorted[i + 1]
        if (next && next.minLevel <= row.maxLevel) errors.push(`成長の規則：引退${label}ボーナスの範囲が重なっています（${row.minLevel}〜${row.maxLevel} と ${next.minLevel}〜${next.maxLevel}）`)
      })
    }
  }

  // ジョブのステータス表：レベルの重複・レベル上限超え
  for (const job of jobs) {
    const lvs = job.stats.map((s) => s.lv)
    for (const lv of new Set(lvs.filter((lv, i) => lvs.indexOf(lv) !== i))) errors.push(`ジョブ ${job.id}: ステータス表に Lv${lv} が重複しています`)
    if (rules) for (const lv of lvs) if (lv > rules.maxLevel) errors.push(`ジョブ ${job.id}: ステータス表の Lv${lv} がレベル上限 ${rules.maxLevel} を超えています`)
  }

  // ID の重複
  const jobIds = jobs.map((j) => j.id)
  for (const id of new Set(jobIds.filter((id, i) => jobIds.indexOf(id) !== i))) errors.push(`ジョブ ID「${id}」が重複しています`)

  const skills = skillFiles.flatMap((f) => f.skills)
  const skillIds = skills.map((s) => s.id)
  for (const id of new Set(skillIds.filter((id, i) => skillIds.indexOf(id) !== i))) errors.push(`スキル ID「${id}」が重複しています`)

  for (const file of skillFiles) {
    if (!jobIds.includes(file.jobId)) errors.push(`スキルファイル ${file.jobId}: ジョブ「${file.jobId}」が jobs に存在しません`)
    for (const skill of file.skills) {
      if (skill.jobId !== file.jobId) errors.push(`スキル ${skill.id}: jobId（${skill.jobId}）がファイルのジョブ（${file.jobId}）と違います`)
      checkSkill(skill, `スキル ${skill.id}`, errors)
    }
  }
  checkPrerequisites(skills, errors)

  // 装備：ID の重複、武器には種類と攻撃力が必要
  const [equipment] = parseAll(EquipmentFile, data.equipment === undefined ? [] : [data.equipment], '装備', errors)
  if (equipment) {
    const ids = equipment.items.map((e) => e.id)
    for (const id of new Set(ids.filter((id, i) => ids.indexOf(id) !== i))) errors.push(`装備 ID「${id}」が重複しています`)
    for (const e of equipment.items) {
      if (e.slot === 'weapon' && (e.weaponType === undefined || e.atk === undefined)) errors.push(`装備 ${e.id}: 武器なのに種類か攻撃力がありません`)
      if (e.jobs.length === 0) errors.push(`装備 ${e.id}: 装備できるジョブがありません`)
    }
  }

  // 敵：ID の重複
  const [enemies] = parseAll(EnemyFile, data.enemies === undefined ? [] : [data.enemies], '敵', errors)
  if (enemies) {
    const ids = enemies.items.map((e) => e.id)
    for (const id of new Set(ids.filter((id, i) => ids.indexOf(id) !== i))) errors.push(`敵 ID「${id}」が重複しています`)
  }

  // レベル差補正の表は −20〜+20 が1行ずつそろっているか
  for (const f of formulaSets) {
    const diffs = f.levelCorrection.map((r) => r.levelDiff).sort((a, b) => a - b)
    const expected = Array.from({ length: 41 }, (_, i) => i - 20)
    if (diffs.join() !== expected.join()) errors.push(`式セット ${f.id}: レベル差補正の表に抜けか重複があります`)
  }

  return errors
}
