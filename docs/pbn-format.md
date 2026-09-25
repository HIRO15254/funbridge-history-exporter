# PBN 2.1 Output Format

English | [日本語](pbn-format.ja.md)

The extension writes one `.pbn` file per tournament. Each board is one PBN game, and games in a file are ordered by board number.

```
funbridge-export/
  bp-circuit/2026-09-15_9001.pbn
  series/2026-09-13_412.pbn
  daily/2026-09-15_9002.pbn
```

A file name consists of the tournament's play date (Asia/Tokyo) and its source tournament ID, so different tournaments never share a name. An existing file with the same name is overwritten.

## File header

```
% PBN 2.1
% EXPORT
%Content-type: text/x-pbn; charset=UTF-8
% Funbridge History Exporter 2.0.0
```

Tournament names can contain non-ASCII characters, so the character set is declared as UTF-8.

## Mandatory tags

The 15 tag pairs required by PBN 2.1 are always written, in the order the standard defines. `?` is used only when a value is unavailable.

| Tag | Value |
| --- | --- |
| `Event` | Tournament name. For BIC, the parent event name |
| `Site` | Always `Funbridge` |
| `Date` | Play date `YYYY.MM.DD` (Asia/Tokyo) |
| `Board` | Board number. For KO, the running number across the tournament |
| `West` / `North` / `East` | `Argine` (the Funbridge robot) |
| `South` | Your numeric Funbridge ID. Funbridge always seats you South |
| `Dealer` | `N` / `E` / `S` / `W` |
| `Vulnerable` | `None` / `NS` / `EW` / `Both` |
| `Deal` | The four hands clockwise, starting with the dealer |
| `Scoring` | `MP` or `IMP` |
| `Declarer` | Declarer. Empty string for a passed-out board |
| `Contract` | `4S` / `3NTX` / `6HXX`. `Pass` for a passed-out board |
| `Result` | Tricks taken by declarer. `0` for a passed-out board |

Contracts are normalized: `3N` → `3NT`, `X1` → `X`, `X2` → `XX`.

## Auction section

`[Auction "<dealer>"]` is followed by the calls, four per line. Calls are `Pass` / `X` / `XX` / `1C` to `7NT`. A call alerted on Funbridge is annotated with `=1=`, and the game gets a `[Note "1:Alerted"]` tag. The section is omitted when the API returns no auction for the board.

## Play section

`[Play "<opening leader>"]` is followed by one line per trick, in fixed seat columns starting with the opening leader. A seat with no card in that trick is written as `-`. When fewer than 52 cards were played, the last line is `*`, which marks an incomplete play record as the PBN standard specifies.

When play ends with a claim, the missing cards are not filled in; the original marker such as `!S9` is kept in `FunbridgeClaimMarker`.

## Supplemental tags (Funbridge-specific)

Information that does not fit the standard PBN tags goes into supplemental tags prefixed with `Funbridge`. They follow the mandatory tags in alphabetical order. Fields that appear only in the history list are also stored here.

### Tournament (same value in every game of a file)

| Tag | Content |
| --- | --- |
| `FunbridgeTournamentId` | Source tournament ID |
| `FunbridgeTournamentFamily` | `BP_CIRCUIT` / `SERIES` / `DAILY` |
| `FunbridgePlayerId` | Your numeric Funbridge ID |
| `FunbridgePlayedAt` | Play date and time in ISO 8601 (keeps the time the `Date` tag drops) |
| `FunbridgeCompletion` | `COMPLETED` / `IN_PROGRESS` |
| `FunbridgeBoardCount` | Number of boards in the tournament, as reported by Funbridge |
| `FunbridgePlayedBoardCount` | Number of played boards actually fetched |
| `FunbridgeTournamentScore` | Your tournament score |
| `FunbridgeRank` | Your tournament rank |
| `FunbridgeParticipantCount` | Total participants in the tournament |
| `FunbridgeRegisteredPlayerCount` | Registered players, from the history list |
| `FunbridgeCapturedAt` | Time of capture |
| `FunbridgeCaptureMode` | `NETWORK_RESPONSE` |

The tags from `FunbridgeTournamentId` through `FunbridgeParticipantCount` are always written, as `?` when the value is unknown.

Family-specific tags:

- BP Circuit: `FunbridgeLevel`, `FunbridgeKind` (`FEDERAL` / `BIC` / `KNOCKOUT`), `FunbridgeCoefficient`, `FunbridgeMultiplier`, `FunbridgeAwarded` (Bridge Points awarded), `FunbridgeParentEventId`, `FunbridgeKnockoutRounds`
- Series: `FunbridgeLevel`, `FunbridgePeriod`, `FunbridgePeriodStartAt`, `FunbridgePeriodEndAt`, `FunbridgeOutcome`, `FunbridgeLastPlayedAt`
- Daily: `FunbridgeRegion`, `FunbridgeEndAt`

### Board

| Tag | Content |
| --- | --- |
| `FunbridgeBoardStatus` | `PLAYED` / `PASSED_OUT` / `NO_PLAY` / `NO_CONTRACT_OR_PLAY` |
| `FunbridgeHeroSeat` | Always `S` |
| `FunbridgeSourceDealId` | Source deal ID |
| `FunbridgeSourceGameId` | Source game ID |
| `FunbridgeBoardRank` | Your rank on the board |
| `FunbridgeBoardParticipantCount` | Number of players compared on the board |
| `FunbridgeBoardScore` | Your board score (percentage for MP, IMPs for IMP) |
| `FunbridgeBoardRawScore` | Your raw score |
| `FunbridgeLead` | Your opening lead |
| `FunbridgeClaimMarker` | Claim marker |

### Contract distribution

`FunbridgeContractGroups` holds every row of "all contracts", with rows separated by semicolons and fields by commas.

```
rank,contract,declarer,tricks,rawScore,score,playerCount
```

```
[FunbridgeContractGroups "1,4S,S,10,420,60,2;2,3NT,S,9,400,25,6"]
```

Related tags:

| Tag | Content |
| --- | --- |
| `FunbridgeContractGroupCoverage` | `FULL` / `VISIBLE_WINDOW` / `NONE` |
| `FunbridgeContractGroupIntegrity` | `RECONCILED` / `MISMATCH` / `UNKNOWN` |
| `FunbridgeContractGroupRowCount` | Number of rows fetched |
| `FunbridgeContractGroupSourceTotal` | Total row count reported by the response |
| `FunbridgeContractGroupParticipantSum` | Sum of players across the rows |
| `FunbridgePassedOutPlayerCount` | Players in the `PA` row |
| `FunbridgeUnclassifiedPlayerCount` | Players in rows whose contract could not be parsed |

If the player sum does not match the participant count, the difference is not corrected; the integrity is `MISMATCH` and the original counts are kept as-is. The internal sentinel `-32000` is never written as a score.

### Knockout

The tournament result API for KO does not return the usual rank fields, so the comparison with the opponent is recorded instead.

| Tag | Content |
| --- | --- |
| `FunbridgeSourceMatchId` | Source match ID |
| `FunbridgeRoundNumber` | Round number |
| `FunbridgeMatchBoardNumber` | Board number within the round |
| `FunbridgeImpDelta` | IMP difference against the opponent |
| `FunbridgeOpponentRawScore` | Opponent's raw score |
| `FunbridgeOpponentContract` | Opponent's contract |
| `FunbridgeOpponentTricks` | Tricks taken by the opponent |

## Data not exported

Authorization headers, cookies, raw responses, HAR files, network request IDs, other players' individual rank rows and display names, email addresses, subscription plans, and account settings are never exported. Values shown only in the UI are never used to fill in fields missing from the responses.

## Tournaments without results

A tournament that appears in the history list but whose result API does not respond gets no file. The popup's completion message shows how many were skipped.
