# Funbridge History Exporter

English | [日本語](README.ja.md)

A Chrome extension (Manifest V3) that fetches your BP Circuit, Series, and Daily history from an authenticated Funbridge Web tab and saves it locally as **PBN 2.1** files.

- Records the deal, auction, actual card play, contract, tricks taken, your board result, and the distribution of all contracts.
- Has no server. Data is sent nowhere except Funbridge and your browser's download folder.
- The authorization header is kept only in the service worker's memory and is never written to `chrome.storage`, output files, or the console.

See [docs/pbn-format.md](docs/pbn-format.md) for the output tags.

## Installation

1. Clone this repository.
2. Open `chrome://extensions` in Chrome.
3. Turn on "Developer mode".
4. Click "Load unpacked" and select the `extension/` directory.

## Usage

1. Log in to Funbridge Web and open the extension while that tab is active.
2. Click "通信を検出" (Detect traffic). Chrome showing that a debugger is attached is expected.
3. In the same tab, open your history or a tournament result once. The extension detects the allowed API URL and the Authorization header.
4. When the status reads "取得準備完了" (Ready), click "全履歴を保存" (Save all history).
5. When it finishes, click "接続を解除" (Disconnect). Closing the tab also detaches the debugger and discards the in-memory credentials.

Your numeric Funbridge ID is detected from the responses. Enter it in the input field only if detection fails. You never need to enter or store a password, cookie, or Authorization header.

## Output

One PBN file per tournament is saved to Chrome's download folder.

```
funbridge-export/
  bp-circuit/2026-09-15_9001.pbn
  series/2026-09-13_412.pbn
  daily/2026-09-15_9002.pbn
```

Each board is one PBN game. Besides the mandatory PBN 2.1 tags, Funbridge-specific data goes into supplemental tags prefixed with `Funbridge`, including fields that appear only in the history list, such as the registered player count, Bridge Points awarded, and the Series period.

Tournaments whose result API does not respond are skipped rather than synthesized; the completion message shows how many were skipped and why.

## How it works

The extension uses `Network` events from the Chrome DevTools Protocol to observe one real request triggered by your own action. With the API route and Authorization header from that request, it calls only the allowed read-only APIs, **from the JavaScript context of the same tab**.

Only these seven endpoints under `/funbridge-server-ws/rest/` are allowed, and the host and path are also checked at runtime.

| Purpose | Endpoint |
| --- | --- |
| BP Circuit history | `bridgePoints/historic` |
| Tournament history (Series / Daily / BIC) | `tournament/getTournamentArchives` |
| Tournament result | `result/getResultDealForTournament` |
| Board summary | `result/getDealResultSummary` |
| Contract distribution | `result/getResultForDeal` |
| KO match list | `tournament/getKnockoutPlayerMatches` |
| KO match result | `tournament/getKnockoutTournamentMatch` |

The Funbridge API is private and may change without notice. If fetching fails, observe the real traffic again and update the endpoints and response-shape detection in `extension/lib/protocol.js`.

## Permissions

| Permission | Purpose |
| --- | --- |
| `debugger` | Observe Network events of the selected Funbridge tab and run the read-only APIs inside that tab |
| `activeTab` | Identify the Funbridge tab where you opened the extension |
| `downloads` | Save the generated PBN files locally |
| host permissions | Limited to `*.funbridge.com` and `*.funbridge.net` |

## Development

```sh
npm install
npm test        # unit tests with node:test
npm run check   # formatting and lint with Biome
```

The tests use only anonymized response fixtures, so no Funbridge account is needed.

The English documents are the source of truth. When you change one, update the matching `.ja.md` translation too.

## License

[MIT](LICENSE)

Funbridge is a trademark of Goto Games. This project is unofficial and not affiliated with Goto Games.
