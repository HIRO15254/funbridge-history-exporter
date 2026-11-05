# Funbridge History Exporter

[English](README.md) | 日本語

> この文書は英語版 [README.md](README.md) の和訳です。内容が異なる場合は英語版を正とします。

Funbridge Web版の認証済みタブから、BP Circuit・Series・Dailyの履歴を取得し、**PBN 2.1**ファイルとしてローカルに保存するChrome拡張機能（Manifest V3）です。

- 配札、宣言、実カードプレイ、契約、獲得トリック、本人のボード成績、全契約の分布を記録します。
- サーバーを持ちません。データはFunbridgeとブラウザーのダウンロード先以外へ送信されません。
- 認証ヘッダーはservice workerのメモリー内だけに保持し、`chrome.storage`・出力ファイル・consoleへは書き込みません。

出力タグは [docs/pbn-format.ja.md](docs/pbn-format.ja.md) を参照してください。

## インストール

1. このリポジトリをクローンする。
2. Chromeで `chrome://extensions` を開く。
3. 「デベロッパー モード」を有効にする。
4. 「パッケージ化されていない拡張機能を読み込む」で `extension/` ディレクトリを選ぶ。

## 使い方

1. Funbridge Web版へログインし、そのタブを表示したまま拡張機能を開く。
2. 「Detect traffic」を押す。Chromeがデバッガー接続中であることを表示するのは想定どおりです。
3. 同じタブで履歴か大会結果を1回開く。拡張機能が許可済みAPIのURLとAuthorizationヘッダーを検出します。DailyとSeriesの大会履歴ページも開いておくと、Funbridgeがその一覧に送る実際のリクエストをそのまま再利用します。
4. 状態が「Ready to export」になったら「Save all history」を押す。
5. 完了したら「Disconnect」を押す。タブを閉じた場合もデバッガー接続が解除され、メモリー内の認証情報は破棄されます。

実行中は拡張機能のアイコンに進捗（例: `12/76`）が出て、完了・失敗時にはデスクトップ通知が届きます。ポップアップを開いたままにしておく必要はありません。

保存するのは新しい大会だけです。保存済みで終了した大会のIDを `chrome.storage.local` に覚えておき（IDとファイルパスのみ）、次回は取得しません。進行中の大会は毎回取得します。全部保存し直したいときは「Re-export everything」にチェックを入れてください。

### Google Driveへの保存

「Also save to Google Drive」にチェックを入れると、マイドライブの `funbridge-export` フォルダにもアップロードします。同じ名前のファイルがすでにあれば飛ばします。Googleの仕様で、自分用のOAuthクライアントを1回だけ作る必要があります。

1. [Google Cloud コンソール](https://console.cloud.google.com/)でプロジェクトを作り、**Google Drive API** を有効にして、OAuth同意画面を設定する（外部、自分をテストユーザーに追加）。
2. 種類「**ウェブ アプリケーション**」のOAuthクライアントIDを作り、「承認済みのリダイレクトURI」にポップアップのクライアントID欄の下に出ているURI（`https://<拡張機能ID>.chromiumapp.org/`）を追加する。
3. クライアントIDをポップアップに貼り付ける。最初のエクスポート時に、拡張機能が作ったファイルへのアクセス（`drive.file` スコープのみ）を許可する。

Googleのアクセストークンは1回のエクスポートの間だけメモリーに保持します。

本人の数字IDはレスポンスから検出します。検出できない場合だけ入力欄へ指定してください。パスワード、Cookie、Authorizationヘッダーを入力・保存する必要はありません。

## 出力

Chromeのダウンロード先に、大会1件あたり1ファイルのPBNを保存します。

```
funbridge-export/
  bp-circuit/2026-09-15_9001.pbn
  series/2026-09-13_412.pbn
  daily/2026-09-15_9002.pbn
```

1ボードがPBNの1ゲームです。PBN 2.1の必須タグに加え、Funbridge固有の情報は `Funbridge` 接頭辞の補助タグに入ります。登録人数・獲得Bridge Points・Series期間など、履歴一覧にしかない情報もここに含まれます。

結果APIが応答しない大会はファイルを合成せずに飛ばし、完了表示にその件数を出します。

## しくみ

Chrome DevTools Protocolの `Network` イベントで、ユーザー自身の操作によって発生した実通信を1回観測します。そこで得たAPIルートとAuthorizationヘッダーを使い、**同じタブのJavaScript実行環境から**許可済みの読み取りAPIだけを呼びます。

許可するのは `/funbridge-server-ws/rest/` 以下の次の7エンドポイントだけで、実行時にもホストとパスを検証します。

| 用途 | エンドポイント |
| --- | --- |
| BP Circuit履歴 | `bridgePoints/historic` |
| 大会履歴（Series / Daily / BIC） | `result/getTournamentArchives` |
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
| `downloads` | 生成したPBNのローカル保存 |
| `storage` | 保存済み大会IDとDrive設定の記憶 |
| `notifications` | 完了・失敗の通知 |
| `identity` | Driveアップロード用のGoogleサインイン |
| host permissions | `*.funbridge.com`、`*.funbridge.net`、`www.googleapis.com`（Driveアップロード）に限定 |

## 開発

```sh
npm install
npm test        # node:test によるユニットテスト
npm run check   # Biome によるフォーマットとLint
```

テストは匿名化したレスポンスのfixtureだけを使うため、Funbridgeアカウントは不要です。

英語版の文書が正です。変更するときは対応する `.ja.md` の和訳も更新してください。

## ライセンス

[MIT](LICENSE)

FunbridgeはGoto Gamesの商標です。このプロジェクトは非公式であり、Goto Gamesとは関係ありません。
