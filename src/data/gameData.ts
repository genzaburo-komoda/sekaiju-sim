// 検査済みのゲームデータ。アプリの画面と計算はここから読む。
// 起動時に validateData で検査し、エラーがあれば画面を出さずに止める（壊れたデータで計算しないため）。
import { rawData } from './index'
import { EnemyFile, EquipmentFile, FormulaSet, Job, ProgressionRules, SkillFile, type Skill } from './schema'
import { validateData } from './validate'

const errors = validateData(rawData)
if (errors.length > 0) {
  throw new Error(`ゲームデータにエラーがあります：\n${errors.join('\n')}`)
}

export const jobs = rawData.jobs.map((j) => Job.parse(j))
export const rules = ProgressionRules.parse(rawData.rules)
export const equipment = EquipmentFile.parse(rawData.equipment).items
/** 敵（第1〜6階層の通常の敵・FOE・ボス。第5・6階層のボス2体は日本語名の資料がなく未入力） */
export const enemies = EnemyFile.parse(rawData.enemies).items
/** 使う式セット（今は EO Wiki・DS版の1つだけ） */
export const formulas = FormulaSet.parse(rawData.formulaSets![0])

const skillFiles = rawData.skillFiles.map((f) => SkillFile.parse(f))

/** ジョブ ID → そのジョブのスキル一覧（データファイルの並び順） */
export const skillsByJob: Record<string, Skill[]> = Object.fromEntries(skillFiles.map((f) => [f.jobId, f.skills]))

export function findJob(jobId: string) {
  const job = jobs.find((j) => j.id === jobId)
  if (!job) throw new Error(`ジョブ「${jobId}」がありません`)
  return job
}

/** ID から装備を探す（見つからなければ undefined） */
export function findEquipment(id: string | null | undefined) {
  return id ? equipment.find((e) => e.id === id) : undefined
}

export function findEnemy(id: string | null | undefined) {
  return id ? enemies.find((e) => e.id === id) : undefined
}

/** そのジョブが装備できる武器 */
export function weaponsFor(jobId: string) {
  return equipment.filter((e) => e.slot === 'weapon' && e.jobs.includes(jobId))
}
