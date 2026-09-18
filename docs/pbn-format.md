# 出力するPBN 2.1の仕様

この拡張機能は大会1件につき1つの `.pbn` ファイルを書き出す。1ボードがPBNの1ゲームに対応し、ファイル内のゲームはボード番号順に並ぶ。

```
funbridge-export/
  bp-circuit/2026-09-15_9001.pbn
  series/2026-09-13_412.pbn
  daily/2026-09-15_9002.pbn
```

ファイル名は大会のプレイ日（Asia/Tokyo）とsource tournament IDで構成し、別大会を同じ名前に畳み込まない。同名ファイルは上書きする。

## ファイルヘッダー

```
% PBN 2.1
% EXPORT
%Content-type: text/x-pbn; charset=UTF-8
% Funbridge History Exporter 2.0.0
```

大会名にASCII外の文字が入るため、文字コードをUTF-8として明示する。

## 必須タグ

PBN 2.1が定める15個のタグペアを規格の順序で必ず書き出す。値が取得できない場合だけ `?` を入れる。

| タグ | 値 |
| --- | --- |
| `Event` | 大会名。BICでは親イベント名 |
| `Site` | `Funbridge` 固定 |
| `Date` | プレイ日 `YYYY.MM.DD`（Asia/Tokyo） |
| `Board` | ボード番号。KOは大会通し番号 |
| `West` / `North` / `East` | `Argine`（Funbridgeのロボット） |
| `South` | 本人のFunbridge数字ID。Funbridgeは常に本人を南に座らせる |
| `Dealer` | `N` / `E` / `S` / `W` |
| `Vulnerable` | `None` / `NS` / `EW` / `Both` |
| `Deal` | ディーラーを先頭とする時計回りの4ハンド |
| `Scoring` | `MP` または `IMP` |
| `Declarer` | ディクレアラー。パスアウトは空文字 |
| `Contract` | `4S` / `3NTX` / `6HXX`。パスアウトは `Pass` |
| `Result` | ディクレアラーの獲得トリック数。パスアウトは `0` |

`3N` → `3NT`、`X1` → `X`、`X2` → `XX` と正規化する。

## Auctionセクション

`[Auction "<dealer>"]` に続けて、1行4コールで宣言を並べる。コールは `Pass` / `X` / `XX` / `1C`〜`7NT` を使う。Funbridgeがアラートを付けたコールには `=1=` を添え、そのゲームに `[Note "1:Alerted"]` を置く。APIに宣言がないボードではセクションごと省略する。

## Playセクション

`[Play "<opening leader>"]` に続けて、オープニングリーダーを先頭列とする固定座席列で各トリックを1行ずつ並べる。そのトリックにカードのない座席は `-` にする。52枚に満たない場合は最終行に `*` を置き、PBNの規約どおり不完全なプレイであることを示す。

クレームでカードが打ち切られた場合、欠けたカードを補完せず `FunbridgeClaimMarker` に元の `!S9` 等の記号を残す。

## 補助タグ（Funbridge固有）

PBNの標準タグに収まらない情報は `Funbridge` 接頭辞の補助タグへ入れる。補助タグは必須タグの後ろにアルファベット順で並ぶ。JSON形式で持っていた履歴索引の情報も、専用ファイルを作らずここへ畳み込む。

### 大会（そのファイルの全ゲームで同じ値）

| タグ | 内容 |
| --- | --- |
| `FunbridgeTournamentId` | source tournament ID |
| `FunbridgeTournamentFamily` | `BP_CIRCUIT` / `SERIES` / `DAILY` |
| `FunbridgePlayerId` | 本人のFunbridge数字ID |
| `FunbridgePlayedAt` | プレイ日時のISO 8601（`Date`タグが失う時刻を保持する） |
| `FunbridgeCompletion` | `COMPLETED` / `IN_PROGRESS` |
| `FunbridgeBoardCount` | 宣言ボード数 |
| `FunbridgePlayedBoardCount` | 実際に取得できたプレイ済みボード数 |
| `FunbridgeTournamentScore` | 本人の大会スコア |
| `FunbridgeRank` | 本人の大会順位 |
| `FunbridgeParticipantCount` | 大会の総参加人数 |
| `FunbridgeRegisteredPlayerCount` | 履歴索引の登録人数 |
| `FunbridgeCapturedAt` | 取得時刻 |
| `FunbridgeCaptureMode` | `NETWORK_RESPONSE` |

`FunbridgeTournamentId` から `FunbridgeParticipantCount` までの9タグは、値が不明でも `?` として必ず出力する。

ファミリー固有のタグ。

- BP Circuit: `FunbridgeLevel`、`FunbridgeKind`（`FEDERAL` / `BIC` / `KNOCKOUT`）、`FunbridgeCoefficient`、`FunbridgeMultiplier`、`FunbridgeAwarded`（獲得Bridge Points）、`FunbridgeParentEventId`、`FunbridgeKnockoutRounds`
- Series: `FunbridgeLevel`、`FunbridgePeriod`、`FunbridgePeriodStartAt`、`FunbridgePeriodEndAt`、`FunbridgeOutcome`、`FunbridgeLastPlayedAt`
- Daily: `FunbridgeRegion`、`FunbridgeEndAt`

### ボード

| タグ | 内容 |
| --- | --- |
| `FunbridgeBoardStatus` | `PLAYED` / `PASSED_OUT` / `NO_PLAY` / `NO_CONTRACT_OR_PLAY` |
| `FunbridgeHeroSeat` | `S` 固定 |
| `FunbridgeSourceDealId` | source deal ID |
| `FunbridgeSourceGameId` | source game ID |
| `FunbridgeBoardRank` | 本人のボード順位 |
| `FunbridgeBoardParticipantCount` | そのボードの比較人数 |
| `FunbridgeBoardScore` | 本人のボードスコア（MPは百分率、IMPはIMP） |
| `FunbridgeBoardRawScore` | 本人の素点 |
| `FunbridgeLead` | 本人のオープニングリード |
| `FunbridgeClaimMarker` | クレーム記号 |

### 契約分布

`FunbridgeContractGroups` は「すべてのコントラクト」の全行を、セミコロン区切りの行・カンマ区切りのフィールドで持つ。

```
rank,contract,declarer,tricks,rawScore,score,playerCount
```

```
[FunbridgeContractGroups "1,4S,S,10,420,60,2;2,3NT,S,9,400,25,6"]
```

付随するタグ。

| タグ | 内容 |
| --- | --- |
| `FunbridgeContractGroupCoverage` | `FULL` / `VISIBLE_WINDOW` / `NONE` |
| `FunbridgeContractGroupIntegrity` | `RECONCILED` / `MISMATCH` / `UNKNOWN` |
| `FunbridgeContractGroupRowCount` | 取得した集計行数 |
| `FunbridgeContractGroupSourceTotal` | レスポンスが申告した総行数 |
| `FunbridgeContractGroupParticipantSum` | 集計行の人数合計 |
| `FunbridgePassedOutPlayerCount` | `PA` 行の人数 |
| `FunbridgeUnclassifiedPlayerCount` | 契約を解釈できなかった行の人数 |

人数合計が参加人数と合わない場合でも差を補正せず、`MISMATCH` と元の人数をそのまま残す。実測では15ボードで±1人の不一致があった。内部センチネル `-32000` はスコアとして出力しない。

### ノックアウト

KOの大会結果APIは通常の順位フィールドを返さないため、対戦相手との比較をタグに残す。

| タグ | 内容 |
| --- | --- |
| `FunbridgeSourceMatchId` | source match ID |
| `FunbridgeRoundNumber` | ラウンド番号 |
| `FunbridgeMatchBoardNumber` | そのラウンド内のボード番号 |
| `FunbridgeImpDelta` | 対戦相手とのIMP差 |
| `FunbridgeOpponentRawScore` | 対戦相手の素点 |
| `FunbridgeOpponentContract` | 対戦相手の契約 |
| `FunbridgeOpponentTricks` | 対戦相手の獲得トリック数 |

## 出力しない情報

認証ヘッダー、Cookie、生レスポンス、HAR、通信requestId、他プレイヤーの個別順位行と表示名、メールアドレス、契約プラン、アカウント設定は出力しない。画面由来のラベルをレスポンスにない値として補完しない。

## 結果を取得できない大会

履歴索引に載っていても結果APIが応答しない大会は、ファイルを合成せずポップアップの完了表示に件数と理由を出す。PBNは大会一覧を表現する形式を持たないため、索引専用ファイルは書き出さない。
