// ゲームデータの形式（スキーマ）の定義。
// JSON ファイルはすべてここで定義した形に合っているかを自動テストで検査する（validate.ts）。
// 仕様書 7章「データ設計」に対応。
import { z } from 'zod'

// ---------------------------------------------------------------
// 共通：確度ラベルと出典
// ---------------------------------------------------------------

/** 確度ラベル。confirmed=ゲーム内で確認、estimated=資料や実測から逆算、unverified=DS版資料などからの流用で未確認 */
export const Confidence = z.enum(['confirmed', 'estimated', 'unverified'])

/** 出典の種類 */
export const SourceKind = z.enum([
  'in-game', // ゲーム内で確認
  'measurement', // 実測（B5）
  'atwiki', // 世界樹の迷宮Wiki（atwiki）
  'eo-wiki', // 英語版 Etrian Odyssey Wiki
  'enemy-data-sheet', // EO1 Enemy Data スプレッドシート
  'other',
])

export const Source = z.object({
  kind: SourceKind,
  confidence: Confidence,
  url: z.url().optional(),
  note: z.string().optional(),
  /** 確認した日（YYYY-MM-DD） */
  checkedAt: z.iso.date().optional(),
})

const Id = z.string().regex(/^[a-z0-9-]+$/, 'ID は半角英小文字・数字・ハイフンのみ')

// ---------------------------------------------------------------
// 列挙型
// ---------------------------------------------------------------

/** 攻撃属性。斬・壊・突・炎・氷・雷 */
export const Element = z.enum(['slash', 'bash', 'pierce', 'fire', 'ice', 'volt'])

/** 武器・盾の種類。スキルの使用条件に使う */
export const WeaponType = z.enum(['sword', 'axe', 'bow', 'whip', 'staff', 'katana', 'shield'])

/** 依存部位。封じられると使えなくなる部位 */
export const BodyPart = z.enum(['head', 'arm', 'leg', 'none'])

/** 状態異常（スタンも含める） */
export const Ailment = z.enum([
  'poison', 'sleep', 'paralysis', 'confusion', 'terror', 'blind', 'curse', 'petrify', 'death', 'stun',
])

/** 縛りの部位 */
export const Bind = z.enum(['head', 'arm', 'leg'])

/** スキルの対象 */
export const Target = z.enum([
  'self',
  'ally-single',
  'ally-row',
  'ally-all',
  'enemy-single',
  'enemy-single-splash', // 1体＋左右（トルネードなど）
  'enemy-row',
  'enemy-all',
  'enemy-random', // ランダムに複数体（ハヤブサ駆けなど）
])

/** 難易度 */
export const Difficulty = z.enum(['expert', 'basic', 'picnic'])

// ---------------------------------------------------------------
// ジョブ
// ---------------------------------------------------------------

/** あるレベルでのステータス */
export const StatRow = z.object({
  lv: z.number().int().min(1).max(99),
  hp: z.number().int().nonnegative(),
  tp: z.number().int().nonnegative(),
  str: z.number().int().nonnegative(),
  vit: z.number().int().nonnegative(),
  agi: z.number().int().nonnegative(),
  luc: z.number().int().nonnegative(),
  tec: z.number().int().nonnegative(),
  confidence: Confidence,
})

export const Job = z.object({
  id: Id,
  name: z.string().min(1),
  /** 武器スキルを持つ武器の種類 */
  skillWeapons: z.array(WeaponType),
  /** 引退ボーナスで上がるステータス */
  retireBonusStat: z.enum(['str', 'vit', 'agi', 'luc', 'tec']),
  /** 分かっているレベルのステータス。全レベル分でなくてよい（間は補間） */
  stats: z.array(StatRow),
  sources: z.array(Source).min(1),
  notes: z.string().optional(),
})

/** レベル範囲ごとの値（引退ボーナスの表など） */
const LevelRangeValue = z.object({
  minLevel: z.number().int().min(1),
  maxLevel: z.number().int().min(1),
  value: z.number().int().nonnegative(),
})

/** 成長の規則（全ジョブ共通）：レベル上限、SP、引退ボーナス */
export const ProgressionRules = z.object({
  maxLevel: z.number().int().positive(),
  /** Lv1 の時点で持っている SP */
  initialSp: z.number().int().nonnegative(),
  /** レベルが1上がるごとに増える SP */
  spPerLevel: z.number().int().positive(),
  /** 引退・休養ができる最低レベル */
  retireMinLevel: z.number().int().positive(),
  /** 引退したときのレベルに応じた SP ボーナス */
  retireSpBonus: z.array(LevelRangeValue),
  /** 引退したときのレベルに応じたステータスボーナス（上がるステータスはジョブごと） */
  retireStatBonus: z.array(LevelRangeValue),
  /** ステータスの上限（HP・TP を除く） */
  statCap: z.number().int().positive(),
  sources: z.array(Source).min(1),
  notes: z.string().optional(),
})

// ---------------------------------------------------------------
// スキル
// ---------------------------------------------------------------

/**
 * スキルのレベル別数値の項目定義。
 * 例：{ id: 'dmg', label: 'ダメージ倍率', unit: 'percent' }
 * 各レベルの values にはこの id をキーにした数値を入れる。
 */
export const SkillParam = z.object({
  id: z.string().regex(/^[a-zA-Z][a-zA-Z0-9]*$/, '項目 ID は半角英数字（先頭は英字）'),
  label: z.string().min(1),
  unit: z.enum(['percent', 'number', 'turns', 'count']),
})

/** あるスキルレベルでの数値 */
export const SkillLevel = z.object({
  lv: z.number().int().min(1).max(15),
  /** 消費TP。パッシブなど TP を使わないスキルは省略 */
  tp: z.number().int().nonnegative().optional(),
  values: z.record(z.string(), z.number()),
})

/** 前提スキル。列挙したものは全て必要（「A、B」表記は両方必要） */
export const Prerequisite = z.object({
  skillId: Id,
  level: z.number().int().min(1).max(10),
})

/** 行動速度。AGI に掛ける補正（仕様書 5.4） */
export const Speed = z.discriminatedUnion('kind', [
  /** 固定の補正。boostFactor は BOOST 時（Lv11〜15 相当）の補正 */
  z.object({ kind: z.literal('agi'), factor: z.number().positive(), boostFactor: z.number().positive().optional() }),
  /** レベルごとに補正が変わる。各レベルの values[paramId] を使う */
  z.object({ kind: z.literal('agi-by-level'), paramId: z.string() }),
  /** 最速行動（速度に関係なく先に動く） */
  z.object({ kind: z.literal('fastest') }),
  /** 戦闘で使わない（パッシブ・探索スキル） */
  z.object({ kind: z.literal('none') }),
])

/** 強化・弱体で変わる値の種類 */
export const ModifierStat = z.enum([
  'damageDealt', // 与ダメージ
  'damageTaken', // 被ダメージ
  'physAtk', 'elemAtk', 'physDef', 'elemDef',
  'agi', 'accuracy', 'evasion', 'healing', 'aggro',
  'maxHp', // 最大HP（ヘルズクライで下がる）
])

/** パッシブで上がる値の種類 */
export const PassiveStat = z.enum([
  'maxHp', 'maxTp', 'str', 'vit', 'agi', 'luc', 'tec',
  'weaponAtk', // 武器攻撃力（マスタリー）
  'physResist', // 物理耐性（DEFブーストなど）
  'elemResist',
  'critRate',
  'healing', // 回復量（メディックの回復系マスタリー）
  'ailmentRate', // 状態異常の付与率（カースメーカーの呪言マスタリー）
  'elementPower', // 術式の SpellATK 補正（アルケミストのマスタリー）
])

/**
 * スキルの効果。計算エンジンはこの type ごとに処理を持つ。
 * 数値はレベルごとに変わるので、ここでは values の項目 ID（〜Param）で指定する。
 */
export const SkillEffect = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('damage'),
    /** 攻撃値の計算方法（仕様書 5.2） */
    attack: z.enum(['str', 'tec', 'hybrid']),
    element: Element,
    /** 複合攻撃の属性部分 */
    hybridElement: Element.optional(),
    target: Target,
    powerParam: z.string(),
    /** 左右の敵への倍率（enemy-single-splash） */
    splashPowerParam: z.string().optional(),
    /** 攻撃対象数の最小・最大（enemy-random） */
    minTargetsParam: z.string().optional(),
    maxTargetsParam: z.string().optional(),
    /** 複合攻撃の属性部分の倍率（無ければ powerParam と同じ） */
    hybridPowerParam: z.string().optional(),
    /** 攻撃回数（固定なら hits、レベルで変わるなら hitsParam） */
    hits: z.number().int().positive().optional(),
    hitsParam: z.string().optional(),
    /** 攻撃回数の最小・最大（同じ敵に何度も当たり得る。ダブルショット・ツバメがえし） */
    minHitsParam: z.string().optional(),
    maxHitsParam: z.string().optional(),
    /** スキルの命中補正（命中率の式の HitRate、仕様書 5.4） */
    accuracyParam: z.string().optional(),
  }),
  z.object({ type: z.literal('ailment'), ailment: Ailment, target: Target, chanceParam: z.string(), damageParam: z.string().optional() }),
  z.object({ type: z.literal('bind'), bind: Bind, target: Target, chanceParam: z.string() }),
  z.object({
    type: z.literal('heal'),
    target: Target,
    /** fixed=固定値、max-hp-ratio=最大HPに対する割合 */
    scaling: z.enum(['fixed', 'max-hp-ratio']),
    amountParam: z.string(),
    /** 回復マスタリー Lv10 での回復量（amountParam は前提スキルのマスタリーのレベルでの値）。メディックの回復スキル */
    maxMasteryParam: z.string().optional(),
    /** per-turn=毎ターン回復する継続回復（癒しの子守唄など）。省略は使ったときに1回 */
    timing: z.enum(['instant', 'per-turn']).optional(),
    /** 戦闘不能の味方を復帰させる（リザレクション）。回復量は復帰時の HP */
    revive: z.boolean().optional(),
    /** 継続回復の持続ターン数（使ったターンを含む）。untilBattleEnd なら戦闘終了まで（2026-10-17 追加、ステップ4-1） */
    durationTurns: z.number().int().positive().optional(),
    untilBattleEnd: z.boolean().optional(),
  }),
  z.object({ type: z.literal('cure'), target: Target, cures: z.array(z.union([Ailment, z.literal('bind-head'), z.literal('bind-arm'), z.literal('bind-leg')])) }),
  z.object({
    type: z.enum(['buff', 'debuff']),
    target: Target,
    modifiers: z
      .array(
        z.object({
          stat: ModifierStat,
          param: z.string(),
          /**
           * 防御の強化・弱体のかかり方（2026-10-17 追加、ステップ4-3）。
           * defense=防御値 DEF にかける（説明が「防御力」のもの）、resistance=属性倍率にかける（説明が「耐性」のもの）。
           * 省略したものは戦闘シミュレーションで使わない
           */
          appliesTo: z.enum(['defense', 'resistance']).optional(),
          /** 効く属性（省略はすべて） */
          elements: z.array(Element).optional(),
        }),
      )
      .min(1),
    /** 持続ターン数（使ったターンを含む）。省略で untilBattleEnd でもなければ、使ったターンだけ */
    durationTurns: z.number().int().positive().optional(),
    /** 戦闘終了まで続く（バードの歌。2026-10-17 追加） */
    untilBattleEnd: z.boolean().optional(),
    /** 一列が対象のとき、どちらの列か（フロントガード・バックガード） */
    row: z.enum(['front', 'back']).optional(),
    /** 1回の敵の行動を軽減したら消える（フロントガード・属性ガード） */
    oneShot: z.boolean().optional(),
  }),
  z.object({
    type: z.literal('passive-stat'),
    stat: PassiveStat,
    param: z.string(),
    /** 特定の武器を装備したときだけ効く（マスタリー） */
    weapon: WeaponType.optional(),
  }),
  z.object({
    type: z.literal('passive-proc'),
    /** 何をきっかけに発動するか */
    trigger: z.enum(['normal-attack', 'take-damage', 'turn-start', 'battle-end']),
    chanceParam: z.string(),
    description: z.string(),
  }),
  z.object({
    type: z.literal('chase'),
    /** 味方のこの属性の攻撃に反応して追撃する */
    triggerElement: Element,
    powerParam: z.string(),
    accuracyParam: z.string().optional(),
  }),
  z.object({
    type: z.literal('escape'),
    chanceParam: z.string(),
    /** 逃走と引き換えにパーティ全員の HP を失う割合（猛進逃走） */
    hpCostParam: z.string().optional(),
  }),
  z.object({ type: z.literal('exploration'), kind: z.enum(['mining', 'logging', 'gathering', 'other']), description: z.string() }),
  /** 計算エンジンでまだ扱わない効果。説明文だけ持つ */
  z.object({ type: z.literal('other'), description: z.string() }),
])

export const Skill = z.object({
  id: Id,
  jobId: Id,
  name: z.string().min(1),
  /** skeleton=構造だけ入力済みで数値は未入力、entered=数値も入力済み */
  status: z.enum(['skeleton', 'entered']),
  category: z.enum(['passive', 'active', 'exploration']),
  maxLevel: z.number().int().min(1).max(10),
  bodyPart: BodyPart,
  /** 使うのに必要な武器（いずれか） */
  weapons: z.array(WeaponType).optional(),
  /** 使うのに必要な構え（ブシドー） */
  stance: z.enum(['jodan', 'seigan', 'iai']).optional(),
  prerequisites: z.array(Prerequisite),
  speed: Speed,
  /** BOOST で5レベル分強化できるか */
  boostable: z.boolean(),
  params: z.array(SkillParam),
  effects: z.array(SkillEffect).min(1),
  /** レベル別の数値（status が entered のとき必須） */
  levels: z.array(SkillLevel).optional(),
  /** BOOST 時の数値（Lv11〜15 相当） */
  boostLevels: z.array(SkillLevel).optional(),
  sources: z.array(Source).min(1),
  notes: z.string().optional(),
})

export const SkillFile = z.object({
  jobId: Id,
  skills: z.array(Skill),
})

// ---------------------------------------------------------------
// 敵（初期値は EO1 Enemy Data スプレッドシート）
// ---------------------------------------------------------------

/** 耐性値（%）。100 が等倍、200 が弱点、0 が無効 */
const Resist = z.number().min(0)

export const Enemy = z.object({
  id: Id,
  name: z.string().min(1),
  /** 英語名（スプレッドシートとの照合用） */
  nameEn: z.string().optional(),
  kind: z.enum(['normal', 'foe', 'boss']),
  /** 出現する階（分かれば） */
  floors: z.array(z.number().int().min(1).max(30)).optional(),
  /** 出現する階層（第1〜6階層） */
  stratum: z.number().int().min(1).max(6).optional(),
  level: z.number().int().min(1),
  hp: z.number().int().positive(),
  str: z.number().int().nonnegative(),
  tec: z.number().int().nonnegative(),
  vit: z.number().int().nonnegative(),
  agi: z.number().int().nonnegative(),
  luc: z.number().int().nonnegative(),
  /** 通常攻撃の基礎命中（%） */
  accuracy: z.number().min(0),
  /** 通常攻撃の属性（スプレッドシートの Attack 列） */
  normalElement: z.enum(['slash', 'bash', 'pierce']).optional(),
  resist: z.object({
    slash: Resist, bash: Resist, pierce: Resist, fire: Resist, ice: Resist, volt: Resist,
    death: Resist, ailment: Resist, head: Resist, arm: Resist, leg: Resist, stun: Resist,
  }),
  sources: z.array(Source).min(1),
  notes: z.string().optional(),
})

// ---------------------------------------------------------------
// 装備
// ---------------------------------------------------------------

export const Equipment = z.object({
  id: Id,
  name: z.string().min(1),
  slot: z.enum(['weapon', 'armor', 'shield', 'helmet', 'gloves', 'boots', 'accessory']),
  weaponType: WeaponType.optional(),
  element: Element.optional(),
  atk: z.number().int().nonnegative().optional(),
  def: z.number().int().nonnegative().optional(),
  /** 付与効果（例：{ str: 3 }、{ iceResist: 10 }） */
  bonuses: z.record(z.string(), z.number()).optional(),
  /** 装備できるジョブの ID */
  jobs: z.array(Id),
  sources: z.array(Source).min(1),
  notes: z.string().optional(),
})

export const EnemyFile = z.object({
  items: z.array(Enemy),
})

// ---------------------------------------------------------------
// 敵の技と行動パターン（ステップ4-5。数値は LP Archive の DS版データの解析、条件は LP Archive と atwiki の記述）
// ---------------------------------------------------------------

/** 敵が味方にかける状態異常・封じ */
export const EnemyAilment = z.union([Ailment, z.literal('bind-head'), z.literal('bind-arm'), z.literal('bind-leg')])

const EnemyInflict = z.object({
  /** かける状態異常。複数あれば all でないかぎり1つを等しい確率で選ぶ（「毒か麻痺」） */
  ailments: z.array(EnemyAilment).min(1),
  /** すべてを別々に判定する（全箇所封じ・太古の呪粉） */
  all: z.boolean().optional(),
  /** 付与率（%）。味方の耐性と難易度の「被状態異常」をかける */
  chance: z.number().min(0),
  /** 毒のダメージ（1ターンあたり） */
  poisonDamage: z.number().int().positive().optional(),
  /** 味方の耐性を無視する（ネクローシス） */
  ignoreResist: z.boolean().optional(),
})

/** 敵の自己強化・味方への弱体の1項目。stat は味方の強化と同じ名前（physAtk は 100+値 の倍率、damageTaken などは値そのものの倍率） */
const EnemyMod = z.object({
  stat: z.enum(['physAtk', 'physDef', 'agi', 'accuracy', 'damageTaken', 'physTaken', 'elemTaken']),
  value: z.number(),
  /** 属性を限るとき（「炎だけ 1% に」など） */
  elements: z.array(Element).optional(),
})

export const EnemySkillEffect = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('damage'),
    element: Element,
    /** 威力（%）。通常攻撃は 100 */
    power: z.number().positive(),
    /** 複合属性のもう1つ（抜刀氷雪改など。それぞれの威力で別々に計算して足す） */
    element2: Element.optional(),
    power2: z.number().positive().optional(),
    /** single=単体、splash=単体＋左右、all=全体、random=ランダムに hits 回（distinct なら同じ人に2回当たらない） */
    target: z.enum(['single', 'splash', 'all', 'random']),
    hits: z.tuple([z.number().int().positive(), z.number().int().positive()]).optional(),
    distinct: z.boolean().optional(),
    /** 左右への威力（%）。無ければ本体と同じ */
    splashPower: z.number().positive().optional(),
    /** 与えたダメージだけ回復する */
    drain: z.boolean().optional(),
    /** 味方の防御の強化を無視する */
    ignoreDefBuff: z.boolean().optional(),
    inflict: EnemyInflict.optional(),
  }),
  z.object({ type: z.literal('inflict'), target: z.enum(['single', 'all']), ...EnemyInflict.shape }),
  z.object({ type: z.literal('self-buff'), mods: z.array(EnemyMod).min(1), turns: z.number().int().positive() }),
  z.object({ type: z.literal('party-debuff'), mods: z.array(EnemyMod).min(1), turns: z.number().int().positive(), inflict: EnemyInflict.optional() }),
  z.object({ type: z.literal('heal'), amount: z.number().int().positive() }),
  z.object({ type: z.literal('regen'), amount: z.number().int().positive(), turns: z.number().int().positive(), revive: z.number().int().positive().optional() }),
  /** 味方の強化をすべて消す */
  z.object({ type: z.literal('dispel') }),
  /** 自分の封じをすべて消す */
  z.object({ type: z.literal('cleanse') }),
  /** このターン、味方の物理攻撃に反撃する */
  z.object({ type: z.literal('counter'), element: Element, power: z.number().positive() }),
  /** 防御（このターン受けるダメージが減る） */
  z.object({ type: z.literal('guard') }),
  /** 仲間を呼ぶ（1対1のシミュレーションでは何もしない） */
  z.object({ type: z.literal('summon') }),
])

export const EnemySkill = z.object({
  id: Id,
  /** 日本語名（atwiki）。資料に無ければ英語名 */
  name: z.string().min(1),
  nameEn: z.string().min(1),
  /** 日本語名の確かさ（atwiki の FOE・ボスのページで確かめた＝なし、敵スキル一覧の部位・効果から対応づけた＝estimated、不明＝unknown） */
  nameConfidence: z.enum(['estimated', 'unknown']).optional(),
  part: BodyPart,
  /** 基礎命中（%）。無ければ敵の通常攻撃と同じ */
  accuracy: z.number().positive().optional(),
  /** 速度補正（%）。無ければ 100 */
  speed: z.number().positive().optional(),
  /** 狙い：front=前列だけ、back=後列を優先、lowest／highest=HP が最も低い／高い味方 */
  aim: z.enum(['front', 'back', 'lowest', 'highest']).optional(),
  effects: z.array(EnemySkillEffect),
  notes: z.string().optional(),
})

/** 行動を選ぶ条件（すべて満たすときに当てはまる）。ターンは 1 から数える */
const AiCondition = z.object({
  turn: z.number().int().positive().optional(),
  turnFrom: z.number().int().positive().optional(),
  /** ターン t が t % m === r（[m, r]） */
  turnMod: z.tuple([z.number().int().min(2), z.number().int().min(0)]).optional(),
  /** 自分の HP の割合（%）が未満／以上 */
  hpBelow: z.number().positive().optional(),
  hpAtLeast: z.number().positive().optional(),
  /** 前のターンに使った技／使わなかった技 */
  prev: z.string().optional(),
  notPrev: z.string().optional(),
  /** 封じられている部位がちょうどこれだけ（ほかは封じられていない） */
  boundExactly: z.array(Bind).optional(),
  /** これらの部位がすべて封じられている／いない */
  bound: z.array(Bind).optional(),
  notBound: z.array(Bind).optional(),
  /** 封じられている部位の数がこれ以上 */
  boundCountAtLeast: z.number().int().positive().optional(),
  /** 味方にかかっている強化の数（メンバーごとに数えた合計）がこれ以上 */
  partyBuffsAtLeast: z.number().int().positive().optional(),
  /** 自分の強化（技 ID）がかかっている／いない */
  selfBuff: z.string().optional(),
  noSelfBuff: z.string().optional(),
  /** 味方のだれかが属性の耐性（強化・防具）を持っているか */
  partyElemResist: z.boolean().optional(),
  /** この確率（%）で当てはまる */
  chance: z.number().positive().max(100).optional(),
})

const AiChoice = z.object({ skill: z.string(), weight: z.number().positive() })

export const AiRule = z.object({
  when: AiCondition,
  use: z.array(AiChoice).min(1),
  /** 重み（確率）が資料に無く、等しい確率などで仮に置いたもの */
  assumed: z.boolean().optional(),
  note: z.string().optional(),
})

export const EnemyBehavior = z.object({
  enemyId: Id,
  skills: z.array(EnemySkill),
  /** 上から順に条件を見て、最初に当てはまった行の表から選ぶ */
  rules: z.array(AiRule),
  /** どの行にも当てはまらないときの表 */
  default: z.array(AiChoice).min(1),
  defaultAssumed: z.boolean().optional(),
  /** 封じで使えない技を選んだとき：normal=通常攻撃にする（既定）、reroll=使える技から選び直す、skip=何もしない */
  onBound: z.enum(['normal', 'reroll', 'skip']).optional(),
  /** 通常攻撃の狙い */
  normalAim: z.enum(['front', 'back', 'lowest', 'highest']).optional(),
  /** 受けるダメージを一定の確率で半分にする（マンティコア） */
  halveDamageChance: z.number().positive().max(100).optional(),
  sources: z.array(Source).min(1),
  notes: z.string().optional(),
})

export const EnemyBehaviorFile = z.object({
  items: z.array(EnemyBehavior),
})

export const EquipmentFile = z.object({
  items: z.array(Equipment),
})

// ---------------------------------------------------------------
// 式セットの定数（仕様書 5.3・5.7）
// ---------------------------------------------------------------

/** レベル差補正の1行。levelDiff = 攻撃側レベル − 防御側レベル */
export const LevelCorrectionRow = z.object({
  levelDiff: z.number().int().min(-20).max(20),
  /** 味方が攻撃するときの倍率（%） */
  playerDealt: z.number().positive(),
  /** 敵が攻撃するときの倍率（%） */
  enemyDealt: z.number().positive(),
})

export const DifficultyModifiers = z.object({
  damageDealt: z.number(),
  damageTaken: z.number(),
  ailmentInflict: z.number(),
  ailmentVulnerability: z.number(),
  healing: z.number(),
  partyAccuracy: z.number(),
  enemyAccuracy: z.number(),
  partySpeed: z.number(),
})

export const FormulaSet = z.object({
  id: Id,
  name: z.string(),
  levelCorrection: z.array(LevelCorrectionRow).length(41),
  difficulty: z.record(Difficulty, DifficultyModifiers),
  sources: z.array(Source).min(1),
})

// ---------------------------------------------------------------
// 型（TypeScript で使う）
// ---------------------------------------------------------------

export type Job = z.infer<typeof Job>
export type ProgressionRules = z.infer<typeof ProgressionRules>
export type Skill = z.infer<typeof Skill>
export type SkillFile = z.infer<typeof SkillFile>
export type SkillEffect = z.infer<typeof SkillEffect>
export type Enemy = z.infer<typeof Enemy>
export type EnemySkill = z.infer<typeof EnemySkill>
export type EnemySkillEffect = z.infer<typeof EnemySkillEffect>
export type EnemyBehavior = z.infer<typeof EnemyBehavior>
export type AiRule = z.infer<typeof AiRule>
export type EnemyFile = z.infer<typeof EnemyFile>
export type Equipment = z.infer<typeof Equipment>
export type EquipmentFile = z.infer<typeof EquipmentFile>
export type FormulaSet = z.infer<typeof FormulaSet>
