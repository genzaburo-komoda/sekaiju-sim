// 最初の画面の道案内（開発計画 U11）。閉じるまで「編成・スキル」などの上に出す
export function Welcome({ onSample, onClose, onGoDamage }: { onSample: () => void; onClose: () => void; onGoDamage: () => void }) {
  return (
    <section className="welcome" aria-labelledby="welcome-title">
      <h2 id="welcome-title">はじめに</h2>
      <ol>
        <li>左の「パーティ」でメンバーを選び、ジョブ・レベル・装備を決める</li>
        <li>「編成・スキル」で、＋／− でスキルを振る</li>
        <li>
          <button type="button" className="link-button" onClick={onGoDamage}>ダメージ計算</button>
          で敵を選ぶと、ダメージが出る
        </li>
      </ol>
      <div className="welcome-buttons">
        <button type="button" onClick={onSample}>サンプルの編成を読み込む</button>
        <button type="button" onClick={onClose}>閉じる</button>
      </div>
      <p className="note">サンプルは Lv70 の5人（ソードマン・パラディン・メディック・アルケミスト・バード）で、今のパーティと入れ替わります。</p>
    </section>
  )
}
