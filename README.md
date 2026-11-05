# Funbridge History Exporter

English | [日本語](README.ja.md)

A Chrome extension (Manifest V3) that fetches your BP Circuit, Series, and Daily history from an authenticated Funbridge Web tab and saves it locally as **PBN 2.1** files.

- Records the deal, auction, actual card play, contract, tricks taken, your board result, and the distribution of all contracts.
- Has no server. Data is sent nowhere except Funbridge, your browser's download folder and, if you turn it on, your Google Drive.
- Your Funbridge sign-in is held only in Chrome's memory (`chrome.storage.session`, never on disk) and is forgotten when Chrome closes. It is never written to `chrome.storage.local`, output files, or the console.

See [docs/pbn-format.md](docs/pbn-format.md) for the output tags.

## Installation

1. Clone this repository.
2. Open `chrome://extensions` in Chrome.
3. Turn on "Developer mode".
4. Click "Load unpacked" and select the `extension/` directory.

## Usage

1. Open [Funbridge](https://play.funbridge.com/) and sign in. The extension picks up the sign-in by itself from the page's own requests; there is nothing to connect.
2. Click the extension icon, then **Export new tournaments**.
   - If Funbridge was already open before the extension was installed or reloaded, the button reads **Reload Funbridge and export**: it reloads that tab once so the sign-in can be seen, then starts.
   - If no Funbridge tab is open, the button opens one.
3. A progress page opens. It shows the step (sign-in, reading history, saving), how many tournaments are done and roughly how long is left, the tournament and board being fetched, a table by type (BP Circuit, Series, Daily), and an activity log with a **Problems** filter for anything that could not be fetched. You can close it; the icon badge (for example `12/76`) and a notification at the end keep you informed, and the popup reopens it.

Each tournament is saved as soon as it is fetched, so an export that stops part way keeps what it saved. The extension remembers finished tournaments it saved (IDs and file paths only, in `chrome.storage.local`) and skips them next time; tournaments still in progress are fetched every time. Tournaments that could not be fetched are tried again on the next export.

Funbridge allows one signed-in web session at a time. If the sign-in expires or Funbridge is opened on another device during an export, the export pauses and asks you to reload the Funbridge tab, then continues by itself. It never signs in on your behalf.

### Settings

The gear in the popup opens the settings page:

- **Also save to Google Drive** (see below).
- **Saved tournaments**: how many are recorded, and **Forget saved tournaments** to save your whole history again next time.
- **Advanced → Your Funbridge ID**: detected automatically from the results; enter it only if detection fails (the progress page also asks for it if needed).

### Saving to Google Drive

Turn on "Also save to Google Drive" in the settings to upload every file to a `funbridge-export` folder in My Drive as well. A file whose name is already in that folder is kept (a tournament that was still running last time is updated). Google requires an OAuth client of your own, created once:

1. In the [Google Cloud console](https://console.cloud.google.com/), create a project, enable the **Google Drive API**, and configure the OAuth consent screen (External, add yourself as a test user).
2. Create an OAuth client ID of type **Web application**. Under "Authorized redirect URIs", add the URI the settings page shows (`https://<extension-id>.chromiumapp.org/`; there is a Copy button).
3. Paste the client ID into the settings page and click **Connect Google Drive** to allow access to files the extension creates (`drive.file` scope only).

After the first approval, later exports sign in to Google without a window. The Google access token is kept in memory only.

You never need to enter or store a password, cookie, or Authorization header.

## Output

One PBN file per tournament is saved to Chrome's download folder.

```
funbridge-export/
  bp-circuit/2026-09-15_9001.pbn
  series/2026-09-13_412.pbn
  daily/2026-09-15_9002.pbn
```

Each board is one PBN game. Besides the mandatory PBN 2.1 tags, Funbridge-specific data goes into supplemental tags prefixed with `Funbridge`, including fields that appear only in the history list, such as the registered player count, Bridge Points awarded, and the Series period.

Tournaments whose result API does not respond are not synthesized; the progress page lists them under **Problems** with the reason.

## How it works

The extension watches the Funbridge page's own API requests with `chrome.webRequest` (read-only, no blocking) and keeps the API route and Authorization header of the signed-in tab. It then calls only the allowed read-only APIs **from the JavaScript context of that same tab** (`chrome.scripting`), so requests carry the page's own origin and cookies. No debugger is attached.

Only these seven endpoints under `/funbridge-server-ws/rest/` are allowed, and the host and path are also checked at runtime.

| Purpose | Endpoint |
| --- | --- |
| BP Circuit history | `bridgePoints/historic` |
| Tournament history (Series / Daily / BIC) | `result/getTournamentArchives` |
| Tournament result | `result/getResultDealForTournament` |
| Board summary | `result/getDealResultSummary` |
| Contract distribution | `result/getResultForDeal` |
| KO match list | `tournament/getKnockoutPlayerMatches` |
| KO match result | `tournament/getKnockoutTournamentMatch` |

The Funbridge API is private and may change without notice. If fetching fails, observe the real traffic again and update the endpoints and response-shape detection in `extension/lib/protocol.js`.

## Permissions

| Permission | Purpose |
| --- | --- |
| `webRequest` | Read the Funbridge page's own API requests to pick up the sign-in (Funbridge API hosts only) |
| `scripting` | Run the read-only API calls inside the signed-in Funbridge tab |
| `downloads` | Save the generated PBN files locally |
| `downloads.ui` | Hide Chrome's download bubble while an export saves many files, and restore it afterwards |
| `storage` | Remember saved tournament IDs and settings (on disk), and the sign-in and progress in memory only |
| `notifications` | Tell you when an export finishes, fails, or needs a Funbridge reload |
| `identity` | Sign in to Google for the optional Drive upload |
| host permissions | Limited to `*.funbridge.com`, `*.funbridge.net`, and `www.googleapis.com` (Drive upload) |

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
