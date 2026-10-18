// ゲームデータの読み込み口。アプリとテストはここからデータを取り出す。
// スキルは json/skills/ にジョブごとのファイルを置けば自動で読み込まれる。
import enemies from './json/enemies.json'
import enemyBehaviors from './json/enemyBehaviors.json'
import equipment from './json/equipment.json'
import formulas from './json/formulas.json'
import jobs from './json/jobs.json'
import rules from './json/rules.json'
import type { DataSet } from './validate'

const skillModules = import.meta.glob('./json/skills/*.json', { eager: true, import: 'default' })

/** 検査前の生データ（形式が正しいかはまだ分からない） */
export const rawData: DataSet = {
  jobs,
  skillFiles: Object.values(skillModules),
  formulaSets: [formulas],
  rules,
  equipment,
  enemies,
  enemyBehaviors,
}
