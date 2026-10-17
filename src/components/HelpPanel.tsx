// ヘルプ・免責・報告窓口（仕様書 11章「利用者向け」「運用」、開発計画 3-4）
import { ISSUES_URL, REPO_URL } from '../links'

export function HelpPanel({ onClose }: { onClose: () => void }) {
  return (
    <section className="measure-panel help-panel" aria-labelledby="help-title">
      <div className="measure-head">
        <h2 id="help-title">使い方</h2>
        <button type="button" onClick={onClose}>閉じる</button>
      </div>

      <h3 className="score-h">このツールについて</h3>
      <p>
        『世界樹の迷宮Ⅰ HD REMASTER』のパーティ構築（スキルの振り方）を計算・最適化・採点する非公式のファンツールです。数値は Steam版を基準にしています。
        計算はすべてこのブラウザの中で行い、サーバーには何も送りません。
      </p>

      <h3 className="score-h">使い方</h3>
      <ol className="help-steps">
        <li><strong>パーティ</strong>：左の欄でメンバーを足し（最大5人）、難易度を選びます。メンバーを選ぶと右に編集画面が出ます。</li>
        <li><strong>メンバー</strong>：ジョブ・レベル・隊列・武器・引退ボーナスを入れると、ステータスと SP が出ます。</li>
        <li><strong>スキル</strong>：＋／−で振ります。前提スキルは自動で取り、前提を下げると上位のスキルも下がります。</li>
        <li><strong>ダメージ計算</strong>：攻撃と敵を選ぶと、ダメージの範囲と期待値が出ます。「計算根拠を見る」で式と値を順に確かめられます。</li>
        <li><strong>最適化</strong>：ダメージ計算の下の欄で、最大ダメージ・状態異常を付ける確率・回復の効率が最大になる振り方を探せます。「この振り方にする」で当てはまります。</li>
        <li><strong>採点</strong>：下の「採点」で、役割ごとに最適な振り方に対する点数・改善案・次に振るスキル・役割バランスが出ます。基準は仮のものです。</li>
        <li><strong>保存・共有</strong>：構築はこのブラウザに自動で保存されます。名前を付けた保存、URL での共有、テキストの書き出しもできます。</li>
        <li><strong>実測記録</strong>：ゲームで出たダメージを記録し、予測と比べられます（式の検証用）。</li>
      </ol>

      <h3 className="score-h">数値の確かさ</h3>
      <ul className="score-reasons">
        <li><span className="badge confirmed">確認済み</span>：ゲーム内で確かめた値</li>
        <li><span className="badge estimated">推定</span>：資料や実測から求めた値</li>
        <li><span className="badge unverified">未検証</span>：資料（多くは DS版の記述や解析）からの値で、Steam版では確かめていないもの</li>
      </ul>
      <p className="note">
        数値と計算式は、世界樹の迷宮 Wiki（atwiki）、英語版 Etrian Odyssey Wiki、敵データの解析スプレッドシートなどの資料と、ゲーム内での実測をもとにしています。多くの値は未検証です。
      </p>

      <h3 className="score-h">免責</h3>
      <p>
        計算結果の正確さは保証しません。ゲーム内の値と違うことがあります。このツールを使ったことによる損害について、作者は責任を負いません。
      </p>

      <h3 className="score-h">誤りの報告・実測値の提供</h3>
      <p>
        数値の誤り、ゲーム内での実測値、不具合は、GitHub の Issue で受け付けています：
        <a href={ISSUES_URL} target="_blank" rel="noreferrer">{ISSUES_URL}</a>
        （GitHub のアカウントが必要です）。権利者の方からのご連絡もこちらへお願いします。ご要請があれば、すぐに内容の修正または公開の停止をします。
      </p>

      <h3 className="score-h">プライバシー</h3>
      <p>
        個人情報は集めません。アクセス解析も入れていません。構築と実測記録は、このブラウザの中（localStorage）にだけ保存されます。
      </p>

      <h3 className="score-h">ライセンス</h3>
      <p>
        このツールのソースコードは MIT ライセンスで公開しています（<a href={REPO_URL} target="_blank" rel="noreferrer">GitHub</a>）。
        ゲームの名称・スキル名などの権利は各権利者に帰属し、MIT ライセンスの対象ではありません。
      </p>
    </section>
  )
}
