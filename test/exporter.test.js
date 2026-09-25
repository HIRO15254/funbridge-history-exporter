import assert from "node:assert/strict";
import test from "node:test";
import { exportAllHistory } from "../extension/lib/exporter.js";
import { ENDPOINTS } from "../extension/lib/protocol.js";
import { archive, capture, tournament } from "./fixtures/capture.js";

function stubApi() {
	const calls = [];
	const post = (endpoint, body) => {
		calls.push({ body, endpoint });
		if (endpoint === ENDPOINTS.bpHistory) {
			return { data: { rows: [], totalSize: 0 } };
		}
		if (endpoint === ENDPOINTS.tournamentArchives) {
			return body.categoryID === 6
				? { data: { offset: 0, rows: [archive], totalSize: 1 } }
				: { data: { rows: [], totalSize: 0 } };
		}
		if (endpoint === ENDPOINTS.dealSummary) {
			return { data: capture.boards[0].summary };
		}
		if (endpoint === ENDPOINTS.dealGroups) {
			return {
				data: {
					listResultDeal: capture.boards[0].groups.listResultDeal,
					totalSize: 1,
					tournament
				}
			};
		}
		throw new Error(`Unexpected fixture endpoint: ${endpoint}`);
	};
	return { calls, post };
}

test("walks history, boards and contract groups, then writes one PBN per tournament", async () => {
	const { calls, post } = stubApi();
	const result = await exportAllHistory({
		accountId: "123456",
		post,
		templates: {}
	});

	assert.equal(result.files.length, 1);
	assert.equal(
		result.files[0].path,
		"funbridge-export/daily/2026-09-15_9001.pbn"
	);
	assert.match(result.files[0].text, /^% PBN 2\.1$/m);
	assert.match(result.files[0].text, /^\[FunbridgeTournamentId "9001"\]$/m);
	assert.equal(result.summary.indexCount, 1);
	assert.equal(result.summary.tournamentFileCount, 1);
	assert.equal(result.summary.boardCount, 1);
	assert.deepEqual(result.summary.skipped, []);

	assert.ok(calls.some(({ endpoint }) => endpoint === ENDPOINTS.dealSummary));
	assert.ok(calls.some(({ endpoint }) => endpoint === ENDPOINTS.dealGroups));
	assert.equal(
		calls.find(({ endpoint }) => endpoint === ENDPOINTS.dealSummary).body
			.dealID,
		7001
	);
});

test("never writes a separate history-index file", async () => {
	const { post } = stubApi();
	const result = await exportAllHistory({
		accountId: "123456",
		post,
		templates: {}
	});
	assert.equal(
		result.files.every((file) => file.path.endsWith(".pbn")),
		true
	);
	assert.equal(
		result.files.some((file) => file.path.includes("history-index")),
		false
	);
});

test("records an unreachable tournament as skipped instead of writing a file", async () => {
	const post = (endpoint, body) => {
		if (endpoint === ENDPOINTS.bpHistory) {
			return { data: { rows: [], totalSize: 0 } };
		}
		if (endpoint === ENDPOINTS.tournamentArchives) {
			return body.categoryID === 6
				? { data: { offset: 0, rows: [archive], totalSize: 1 } }
				: { data: { rows: [], totalSize: 0 } };
		}
		throw new Error("Results unavailable.");
	};
	const result = await exportAllHistory({
		accountId: "123456",
		post,
		templates: {}
	});
	assert.equal(result.files.length, 0);
	assert.equal(result.summary.indexCount, 1);
	assert.deepEqual(result.summary.skipped, [
		{
			family: "DAILY",
			reason: "Results unavailable.",
			sourceTournamentId: "9001",
			title: "Daily fixture"
		}
	]);
});

test("fails loudly when the player id cannot be resolved", async () => {
	const { post } = stubApi();
	await assert.rejects(
		() => exportAllHistory({ post, templates: {} }),
		/Funbridge ID/
	);
});
