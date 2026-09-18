import assert from "node:assert/strict";
import test from "node:test";
import { buildTournamentPbn, pbnFileName } from "../extension/lib/pbn.js";
import { capture, capturedAt } from "./fixtures/capture.js";

const built = buildTournamentPbn("DAILY", capture, capturedAt, "test 0.0.0");
const text = built.text;

function tags(source) {
	return Object.fromEntries(
		[
			...source.matchAll(/^\[([A-Za-z][A-Za-z0-9_]*)\s+"((?:\\.|[^"])*)"\]$/gm)
		].map((match) => [
			match[1],
			match[2].replace(/\\"/g, '"').replace(/\\\\/g, "\\")
		])
	);
}

function section(source, name) {
	const start = source.indexOf(`[${name} "`);
	if (start < 0) {
		return [];
	}
	const body = source.slice(source.indexOf("]", start) + 1);
	const end = body.indexOf("[");
	return (end < 0 ? body : body.slice(0, end))
		.split("\n")
		.map((line) => line.trim())
		.filter(Boolean);
}

test("emits a PBN 2.1 export header with an explicit charset", () => {
	const lines = text.split("\n");
	assert.equal(lines[0], "% PBN 2.1");
	assert.equal(lines[1], "% EXPORT");
	assert.equal(lines[2], "%Content-type: text/x-pbn; charset=UTF-8");
	assert.equal(lines[3], "% test 0.0.0");
});

test("writes every mandatory tag pair in the order of the standard", () => {
	const names = [...text.matchAll(/^\[([A-Za-z][A-Za-z0-9_]*)\s/gm)].map(
		(match) => match[1]
	);
	assert.deepEqual(names.slice(0, 15), [
		"Event",
		"Site",
		"Date",
		"Board",
		"West",
		"North",
		"East",
		"South",
		"Dealer",
		"Vulnerable",
		"Deal",
		"Scoring",
		"Declarer",
		"Contract",
		"Result"
	]);
});

test("maps the Funbridge board result onto the mandatory tags", () => {
	const value = tags(text);
	assert.equal(value.Event, "Daily fixture");
	assert.equal(value.Site, "Funbridge");
	assert.equal(value.Date, "2026.09.15");
	assert.equal(value.Board, "1");
	assert.equal(value.South, "123456");
	assert.equal(value.North, "Argine");
	assert.equal(value.Dealer, "N");
	assert.equal(value.Vulnerable, "None");
	assert.equal(value.Scoring, "MP");
	assert.equal(value.Declarer, "S");
	assert.equal(value.Contract, "4S");
	assert.equal(value.Result, "10");
});

test("orders the Deal tag hands clockwise from the dealer", () => {
	assert.equal(
		tags(text).Deal,
		"N:AKQJ.AKQ.AKQ.AKQ T987.JT98.JT9.JT 6543.765.8765.76 2.432.432.985432"
	);
});

test("keeps all 52 cards unique across the four hands", () => {
	const hands = tags(text).Deal.slice(2).split(" ");
	assert.equal(hands.length, 4);
	const cards = hands.flatMap((hand) =>
		hand
			.split(".")
			.flatMap((ranks, index) =>
				[...ranks].map((rank) => `${"SHDC"[index]}${rank}`)
			)
	);
	assert.equal(cards.length, 52);
	assert.equal(new Set(cards).size, 52);
});

test("writes the auction in PBN call notation, four calls to a line", () => {
	assert.equal(tags(text).Auction, "N");
	assert.deepEqual(section(text, "Auction"), ["1S Pass 4S Pass", "Pass Pass"]);
});

test("lays the play out in fixed seat columns and marks it incomplete", () => {
	assert.equal(tags(text).Play, "W");
	assert.deepEqual(section(text, "Play"), ["S2 SA ST S6", "*"]);
});

test("keeps the claim marker instead of inventing the missing cards", () => {
	assert.equal(tags(text).FunbridgeClaimMarker, "!S9");
});

test("folds the history-index row into the tournament tags", () => {
	const value = tags(text);
	assert.equal(value.FunbridgeTournamentId, "9001");
	assert.equal(value.FunbridgeTournamentFamily, "DAILY");
	assert.equal(value.FunbridgePlayerId, "123456");
	assert.equal(value.FunbridgePlayedAt, "2026-09-15T12:00:00.000Z");
	assert.equal(value.FunbridgeCompletion, "COMPLETED");
	assert.equal(value.FunbridgeBoardCount, "1");
	assert.equal(value.FunbridgePlayedBoardCount, "1");
	assert.equal(value.FunbridgeTournamentScore, "60");
	assert.equal(value.FunbridgeRank, "1");
	assert.equal(value.FunbridgeParticipantCount, "2");
	assert.equal(value.FunbridgeRegisteredPlayerCount, "2");
	assert.equal(value.FunbridgeRegion, "Daily fixture");
	assert.equal(value.FunbridgeCaptureMode, "NETWORK_RESPONSE");
});

test("records the board comparison and the full contract distribution", () => {
	const value = tags(text);
	assert.equal(value.FunbridgeBoardRank, "1");
	assert.equal(value.FunbridgeBoardParticipantCount, "2");
	assert.equal(value.FunbridgeBoardScore, "60");
	assert.equal(value.FunbridgeBoardRawScore, "420");
	assert.equal(value.FunbridgeLead, "S2");
	assert.equal(value.FunbridgeContractGroups, "1,4S,S,10,420,60,2");
	assert.equal(value.FunbridgeContractGroupCoverage, "FULL");
	assert.equal(value.FunbridgeContractGroupIntegrity, "RECONCILED");
	assert.equal(value.FunbridgeContractGroupParticipantSum, "2");
});

test("names the file after the local play date and the source tournament", () => {
	assert.equal(
		pbnFileName("daily", built),
		"funbridge-export/daily/2026-09-15_9001.pbn"
	);
});

test("marks a passed-out board with the PBN Pass contract", () => {
	const passedOut = structuredClone(capture);
	passedOut.boards[0].summary.deal.contract = "PA";
	passedOut.boards[0].summary.deal.bidList = "PAN-PAE-PAS-PAW";
	passedOut.boards[0].summary.deal.playList = "";
	const value = tags(
		buildTournamentPbn("DAILY", passedOut, capturedAt, "test 0.0.0").text
	);
	assert.equal(value.Contract, "Pass");
	assert.equal(value.Declarer, "");
	assert.equal(value.Result, "0");
	assert.equal(value.FunbridgeBoardStatus, "PASSED_OUT");
});

test("normalises doubled and no-trump contracts to PBN denominations", () => {
	const doubled = structuredClone(capture);
	doubled.boards[0].summary.deal.contract = "3NX2";
	doubled.boards[0].groups.listResultDeal[0].contract = "3NX1";
	const value = tags(
		buildTournamentPbn("DAILY", doubled, capturedAt, "test 0.0.0").text
	);
	assert.equal(value.Contract, "3NTXX");
	assert.equal(value.FunbridgeContractGroups, "1,3NTX,S,10,420,60,2");
});

test("reports a contract-group participant mismatch instead of correcting it", () => {
	const mismatched = structuredClone(capture);
	mismatched.boards[0].summary.result.listResultDeal[0].nbTotalPlayer = 3;
	const value = tags(
		buildTournamentPbn("DAILY", mismatched, capturedAt, "test 0.0.0").text
	);
	assert.equal(value.FunbridgeContractGroupIntegrity, "MISMATCH");
	assert.equal(value.FunbridgeContractGroupParticipantSum, "2");
	assert.equal(value.FunbridgeBoardParticipantCount, "3");
});

test("escapes quotes and backslashes inside tag values", () => {
	const quoted = structuredClone(capture);
	quoted.archive.title = 'Daily "A\\B"';
	const raw = buildTournamentPbn(
		"DAILY",
		quoted,
		capturedAt,
		"test 0.0.0"
	).text;
	assert.match(raw, /^\[Event "Daily \\"A\\\\B\\""\]$/m);
	assert.equal(tags(raw).Event, 'Daily "A\\B"');
});
