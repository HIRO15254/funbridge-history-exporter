# Funbridge History Exporter

Funbridge Web版の認証済みタブから、BP Circuit・Series・Dailyの対戦履歴を取得し、**PBN 2.1**ファイルとしてローカルに保存するChrome拡張機能（Manifest V3）です。

- 配札、宣言、実カードプレイ、契約、獲得トリック、本人のボード成績、全契約の分布をPBNへ残します。
- サーバーを持ちません。データはFunbridgeとブラウザーのダウンロード先以外へ送信されません。
- 認証ヘッダーはservice workerのメモリー内だけで使い、`chrome.storage`・出力ファイル・consoleへ書き込みません。

出力タグの詳細は [docs/pbn-format.md](docs/pbn-format.md) を参照してください。

## インストール

1. このリポジトリをクローンする。
2. Chromeで `chrome://extensions` を開く。
3. 「デベロッパー モード」を有効にする。
4. 「パッケージ化されていない拡張機能を読み込む」で `extension/` ディレクトリを選ぶ。

## 使い方

1. Funbridge Web版へログインし、そのタブを表示したまま拡張機能を開く。
2. 「通信を検出」を押す。Chromeがデバッガー接続中であることを表示するのは正常です。
3. 同じタブで履歴か大会結果を1回開く。拡張機能が許可済みAPIのURLとAuthorizationヘッダーを検出します。
4. 「取得準備完了」になったら「全履歴を保存」を押す。
5. 取得後に「接続を解除」を押す。タブを閉じた場合も接続とメモリー内の認証情報は破棄されます。

本人の数字IDはレスポンスから自動検出します。検出できない場合だけ入力欄へ指定してください。パスワード、Cookie、Authorizationヘッダーを入力・保存する必要はありません。

## 出力

Chromeのダウンロード先に、大会1件あたり1ファイルのPBNを保存します。

```
funbridge-export/
  bp-circuit/2026-09-15_9001.pbn
  series/2026-09-13_412.pbn
  daily/2026-09-15_9002.pbn
```

1ボードがPBNの1ゲームです。PBN 2.1の必須タグに加え、Funbridge固有の情報は `Funbridge` 接頭辞の補助タグに入ります。履歴一覧にしかない登録人数・獲得Bridge Points・Series期間なども、索引専用ファイルを作らず各大会のPBNタグへ畳み込みます。

結果APIが応答しない大会はファイルを合成せず、完了表示に件数と理由を出します。

## しくみ

Chrome DevTools Protocolの `Network` イベントで、ユーザー自身の操作によって発生した実通信を1回観測します。そこで得たAPIルートとAuthorizationヘッダーを使い、**同じタブのJavaScript実行環境から**許可済みの読み取りAPIだけを呼びます。

許可するのは `/funbridge-server-ws/rest/` 以下の次の7エンドポイントだけで、実行時にもホストとパスを検証します。

| 用途 | エンドポイント |
| --- | --- |
| BP Circuit履歴 | `bridgePoints/historic` |
| 大会履歴（Series / Daily / BIC） | `tournament/getTournamentArchives` |
| 大会結果 | `result/getResultDealForTournament` |
| ボード概要 | `result/getDealResultSummary` |
| 契約分布 | `result/getResultForDeal` |
| KO対戦一覧 | `tournament/getKnockoutPlayerMatches` |
| KO対戦結果 | `tournament/getKnockoutTournamentMatch` |

FunbridgeのAPIは非公開であり、予告なく変わり得ます。取得に失敗する場合は実通信を再観測し、`extension/lib/protocol.js` のエンドポイントとレスポンス形の検出を更新してください。

## 権限

| 権限 | 用途 |
| --- | --- |
| `debugger` | 選択中のFunbridgeタブのNetworkイベント観測と、そのタブ内での読み取りAPI実行 |
| `activeTab` | ユーザーが拡張機能を開いたFunbridgeタブの特定 |
| `downloads` | 整形済みPBNのローカル保存 |
| host permissions | `*.funbridge.com` と `*.funbridge.net` に限定 |

## 開発

```sh
npm install
npm test        # node:test によるユニットテスト
npm run check   # Biome によるフォーマットとLint
```

テストは匿名化したレスポンスのfixtureだけを使うため、Funbridgeアカウントは不要です。`test/pbn.test.js` がPBNの必須タグ、Dealタグの並び、52枚一意、Auction・Playセクションの体裁、契約分布の整合性表示を検証します。

## 由来

もとは [bridge-portal](https://github.com/HIRO15254/bridge-portal) のスキルへ同梱していた拡張機能です。単体で使えるようリポジトリを分離し、出力をJSONからPBN 2.1へ変更しました。

## ライセンス

[MIT](LICENSE)

Funbridgeは Goto Games の商標です。このプロジェクトは非公式であり、Goto Gamesとは関係ありません。
