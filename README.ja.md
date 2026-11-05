# Funbridge History Exporter

[English](README.md) | 日本語

> この文書は英語版 [README.md](README.md) の和訳です。内容が異なる場合は英語版を正とします。

Funbridge Web版の認証済みタブから、BP Circuit・Series・Dailyの履歴を取得し、**PBN 2.1**ファイルとしてローカルに保存するChrome拡張機能（Manifest V3）です。

- 配札、宣言、実カードプレイ、契約、獲得トリック、本人のボード成績、全契約の分布を記録します。
- サーバーを持ちません。データはFunbridge、ブラウザーのダウンロード先、（有効にした場合）Google Drive以外へ送信されません。
- Funbridgeのサインインは Chrome のメモリー上（`chrome.storage.session`、ディスクには書かない）だけに保持し、Chromeを閉じると消えます。`chrome.storage.local`・出力ファイル・consoleへは書き込みません。

出力タグは [docs/pbn-format.ja.md](docs/pbn-format.ja.md) を参照してください。

## インストール

1. このリポジトリをクローンする。
2. Chromeで `chrome://extensions` を開く。
3. 「デベロッパー モード」を有効にする。
4. 「パッケージ化されていない拡張機能を読み込む」で `extension/` ディレクトリを選ぶ。

## 使い方

1. [Funbridge](https://play.funbridge.com/) を開いてサインインする。サインインはページ自身の通信から自動で検出されるので、接続操作はいりません。
2. 拡張機能のアイコンを押し、**新しい大会をエクスポート** を押す。
   - 拡張機能を入れる（再読み込みする）前から Funbridge を開いていた場合、ボタンは **Funbridge を再読み込みしてエクスポート** になります。そのタブを1回再読み込みしてサインインを確認してから始めます。
   - Funbridge のタブがなければ、ボタンで開けます。
3. 進捗ページが開きます。今の段階（サインイン確認・履歴の読み込み・保存）、何件終わったかと残り時間の目安、取得中の大会とボード、種類別（BP Circuit・Series・Daily）の表、取得できなかったものを絞り込める「問題」フィルター付きのアクティビティが見られます。閉じても構いません。アイコンのバッジ（例: `12/76`）と完了時の通知で状況がわかり、ポップアップから開き直せます。

大会は取得するたびにすぐ保存するので、途中で止まっても保存済みの分は残ります。保存した終了済みの大会を `chrome.storage.local` に覚えておき（IDとファイルパスのみ）、次回は飛ばします。進行中の大会は毎回取得します。取得できなかった大会は次回のエクスポートで再取得します。

Funbridge は Web のサインインを同時に1つしか認めません。エクスポート中にサインインの期限が切れたり、別の端末で Funbridge を開いたりすると、エクスポートは一時停止して Funbridge タブの再読み込みを求め、再読み込み後に自動で再開します。拡張機能が代わりにサインインすることはありません。

### 設定

ポップアップの歯車から設定ページを開けます。

- **Google ドライブにも保存する**（下記）。
- **保存済みの大会**: 記録している件数と、次回に履歴全体を保存し直すための **保存済みの記録を消す**。
- **詳細設定 → Funbridge ID**: 結果から自動で検出します。検出できない場合だけ入力してください（必要なときは進捗ページでも入力を求めます）。

### Google Driveへの保存

設定で「Google ドライブにも保存する」をオンにすると、マイドライブの `funbridge-export` フォルダにもアップロードします。同じ名前のファイルがすでにあればそのままにします（前回進行中だった大会は更新します）。Googleの仕様で、自分用のOAuthクライアントを1回だけ作る必要があります。

1. [Google Cloud コンソール](https://console.cloud.google.com/)でプロジェクトを作り、**Google Drive API** を有効にして、OAuth同意画面を設定する（外部、自分をテストユーザーに追加）。
2. 種類「**ウェブ アプリケーション**」のOAuthクライアントIDを作り、「承認済みのリダイレクトURI」に設定ページに出ているURI（`https://<拡張機能ID>.chromiumapp.org/`、コピーボタンあり）を追加する。
3. クライアントIDを設定ページに貼り付け、**Google ドライブに接続** を押して、拡張機能が作ったファイルへのアクセス（`drive.file` スコープのみ）を許可する。

最初に許可したあとは、次回以降のエクスポートでGoogleのウィンドウを出さずにサインインします。Googleのアクセストークンはメモリー上だけに保持します。

パスワード、Cookie、Authorizationヘッダーを入力・保存する必要はありません。

## 出力

Chromeのダウンロード先に、大会1件あたり1ファイルのPBNを保存します。

```
funbridge-export/
  bp-circuit/2026-09-15_9001.pbn
  series/2026-09-13_412.pbn
  daily/2026-09-15_9002.pbn
```

1ボードがPBNの1ゲームです。PBN 2.1の必須タグに加え、Funbridge固有の情報は `Funbridge` 接頭辞の補助タグに入ります。登録人数・獲得Bridge Points・Series期間など、履歴一覧にしかない情報もここに含まれます。

結果APIが応答しない大会はファイルを合成しません。進捗ページの「問題」に理由とともに表示します。

## しくみ

`chrome.webRequest`（読み取りのみ、通信は止めない）でFunbridgeページ自身のAPI通信を見て、サインイン済みタブのAPIルートとAuthorizationヘッダーを保持します。そのうえで、**同じタブのJavaScript実行環境から**（`chrome.scripting`）許可済みの読み取りAPIだけを呼ぶので、リクエストはページ自身のオリジンとCookieで送られます。デバッガーは使いません。

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
| `webRequest` | サインインを検出するためのFunbridgeページ自身のAPI通信の読み取り（FunbridgeのAPIホストのみ） |
| `scripting` | サインイン済みFunbridgeタブ内での読み取りAPI実行 |
| `downloads` | 生成したPBNのローカル保存 |
| `downloads.ui` | 多数のファイルを保存する間だけChromeのダウンロード表示を隠し、終了後に戻す |
| `storage` | 保存済み大会IDと設定の記憶（ディスク）、サインインと進捗の保持（メモリー上のみ） |
| `notifications` | 完了・失敗・Funbridge再読み込みが必要なときの通知 |
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
