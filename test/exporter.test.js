import assert from "node:assert/strict";
import test from "node:test";
import { archiveRequestBody, runExport } from "../extension/lib/exporter.js";
import { ApiError, ENDPOINTS } from "../extension/lib/protocol.js";
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

// Runs an export the way the background worker does, collecting what would
// be saved and every progress event.
async function exportWith(post, options = {}) {
	const events = [];
	const saved = [];
	const result = await runExport({
		accountId: "123456",
		onEvent: (event) => events.push(event),
		post,
		saveTournament: async (tournament) => {
			saved.push(tournament);
			return {};
		},
		templates: {},
		...options
	});
	return { events, result, saved };
}

const types = (events) => events.map((event) => event.type);

test("walks history, boards and contract groups, then saves one PBN per tournament", async () => {
	const { calls, post } = stubApi();
	const { events, result, saved } = await exportWith(post);

	assert.equal(saved.length, 1);
	assert.equal(saved[0].key, "DAILY:9001");
	assert.equal(saved[0].complete, true);
	assert.equal(saved[0].files.length, 1);
	assert.equal(
		saved[0].files[0].path,
		"funbridge-export/daily/2026-09-15_9001.pbn"
	);
	assert.match(saved[0].files[0].text, /^% PBN 2\.1$/m);
	assert.match(saved[0].files[0].text, /^\[FunbridgeTournamentId "9001"\]$/m);
	assert.deepEqual(result, { already: 0, failed: 0, found: 1, saved: 1 });

	assert.deepEqual(types(events), [
		"listing",
		"listed",
		"listing",
		"listed",
		"listing",
		"listed",
		"plan",
		"tournament-start",
		"board",
		"tournament-saved",
		"done"
	]);
	const plan = events.find((event) => event.type === "plan");
	assert.deepEqual(plan.found, { BP_CIRCUIT: 0, DAILY: 1, SERIES: 0 });
	assert.equal(plan.toFetch, 1);
	assert.deepEqual(
		events.find((event) => event.type === "board"),
		{ board: 1, boards: 1, type: "board" }
	);
	const savedEvent = events.find((event) => event.type === "tournament-saved");
	assert.equal(savedEvent.title, "Daily fixture");
	assert.equal(savedEvent.boards, 1);

	assert.equal(
		calls.find(({ endpoint }) => endpoint === ENDPOINTS.dealSummary).body
			.dealID,
		"7001"
	);
});

test("never writes a separate history-index file", async () => {
	const { post } = stubApi();
	const { saved } = await exportWith(post);
	const paths = saved.flatMap((tournament) =>
		tournament.files.map((file) => file.path)
	);
	assert.equal(
		paths.every((path) => path.endsWith(".pbn")),
		true
	);
	assert.equal(
		paths.some((path) => path.includes("history-index")),
		false
	);
});

test("reports an unreachable tournament as failed and keeps going", async () => {
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
	const { events, result, saved } = await exportWith(post);
	assert.equal(saved.length, 0);
	assert.equal(result.failed, 1);
	const failed = events.find((event) => event.type === "tournament-failed");
	assert.equal(failed.family, "DAILY");
	assert.equal(failed.key, "DAILY:9001");
	assert.equal(failed.reason, "Results unavailable.");
	assert.equal(events.at(-1).type, "done");
});

test("stops when the player id cannot be resolved, and uses the last known one", async () => {
	const { post } = stubApi();
	await assert.rejects(
		() => exportWith(post, { accountId: undefined }),
		(error) => error.code === "NO_ACCOUNT_ID"
	);
	const { saved } = await exportWith(stubApi().post, {
		accountId: "",
		knownAccountId: "777"
	});
	assert.equal(saved.length, 1);
});

test("builds archive requests from the body the page actually sent", () => {
	const templates = {
		[ENDPOINTS.tournamentArchives]: {
			body: { categoryID: 6, count: 20, offset: 40, tournamentId: "1", type: 2 }
		},
		[`${ENDPOINTS.tournamentArchives}#8`]: {
			body: { categoryID: 8, count: 30, offset: 0, filter: "series" }
		}
	};
	assert.deepEqual(archiveRequestBody(templates, 6), {
		categoryID: 6,
		count: 20,
		offset: 0,
		type: 2
	});
	assert.deepEqual(archiveRequestBody(templates, 8), {
		categoryID: 8,
		count: 30,
		filter: "series",
		offset: 0
	});
	assert.deepEqual(archiveRequestBody({}, 32, { tournamentId: "77" }), {
		categoryID: 32,
		count: 50,
		offset: 0,
		tournamentId: "77"
	});
});

test("sends the observed archive template when walking Daily history", async () => {
	const { calls, post } = stubApi();
	await exportWith(post, {
		templates: {
			[ENDPOINTS.tournamentArchives]: {
				body: { categoryID: 6, count: 25, offset: 0, extra: true }
			}
		}
	});
	const daily = calls.find(
		({ body, endpoint }) =>
			endpoint === ENDPOINTS.tournamentArchives && body.categoryID === 6
	);
	assert.equal(daily.body.extra, true);
	assert.equal(daily.body.count, 25);
});

test("keeps exporting when one history list is unavailable", async () => {
	const post = (endpoint, body) => {
		if (endpoint === ENDPOINTS.tournamentArchives && body.categoryID === 8) {
			throw new Error(
				"result/getTournamentArchives: response is not JSON (HTTP 404)."
			);
		}
		return stubApi().post(endpoint, body);
	};
	const { events, saved } = await exportWith(post);
	assert.equal(saved.length, 1);
	assert.deepEqual(
		events.find((event) => event.type === "list-failed"),
		{
			family: "SERIES",
			reason: "result/getTournamentArchives: response is not JSON (HTTP 404).",
			type: "list-failed"
		}
	);
});

test("explains what was tried when the history is empty", async () => {
	const post = (endpoint) => {
		if (endpoint === ENDPOINTS.bpHistory) {
			return { data: { listHistoric: [], totalSize: 0 } };
		}
		throw new Error(
			"result/getTournamentArchives: response is not JSON (HTTP 404)."
		);
	};
	await assert.rejects(
		() => exportWith(post),
		(error) => {
			assert.equal(error.code, "NO_HISTORY");
			assert.match(error.message, /DAILY history could not be read/);
			assert.match(
				error.message,
				/BP Circuit response shape: \{data:\{listHistoric:\[0\],totalSize:number\}\}/
			);
			return true;
		}
	);
});

test("reads BP Circuit history rows keyed by tournamentId", async () => {
	const calls = [];
	const post = (endpoint, body) => {
		calls.push({ endpoint, body });
		if (endpoint === ENDPOINTS.bpHistory) {
			return {
				exception: null,
				data: {
					bridgePointsTournaments: [
						{ id: null, tournamentId: "692db557a0208a3529863465", title: "BP" }
					],
					totalSize: 1,
					offset: 0,
					nbMax: 45
				}
			};
		}
		if (endpoint === ENDPOINTS.tournamentArchives) {
			return { data: { archives: [], totalSize: 0 } };
		}
		throw new Error("Results unavailable.");
	};
	const { events } = await exportWith(post);
	assert.equal(
		events.find((event) => event.type === "tournament-failed").key,
		"BP_CIRCUIT:692db557a0208a3529863465"
	);
	assert.equal(calls[0].body.nbMax, 50);
	assert.equal(calls[0].body.count, undefined);
});

test("skips finished tournaments that were already saved, but not running ones", async () => {
	const post = (endpoint, body) => {
		if (endpoint === ENDPOINTS.tournamentArchives && body.categoryID === 6) {
			return {
				data: {
					archives: [archive, { ...archive, id: "9002", finished: false }],
					totalSize: 2
				}
			};
		}
		return stubApi().post(endpoint, body);
	};
	const { events, result, saved } = await exportWith(post, {
		isAlreadyExported: (key) => key === "DAILY:9001" || key === "DAILY:9002"
	});
	assert.equal(result.already, 1);
	assert.deepEqual(events.find((event) => event.type === "plan").already, {
		BP_CIRCUIT: 0,
		DAILY: 1,
		SERIES: 0
	});
	assert.equal(saved.length, 1);
	assert.equal(saved[0].key, "DAILY:9002");
	assert.equal(saved[0].complete, false);
});

function twoDailyTournaments(failOn) {
	let summaries = 0;
	return (endpoint, body) => {
		if (endpoint === ENDPOINTS.tournamentArchives && body.categoryID === 6) {
			return {
				data: { archives: [archive, { ...archive, id: "9002" }], totalSize: 2 }
			};
		}
		if (endpoint === ENDPOINTS.dealSummary && ++summaries === failOn) {
			throw new ApiError("result/getDealResultSummary: expired", {
				code: "AUTH_EXPIRED"
			});
		}
		return stubApi().post(endpoint, body);
	};
}

test("stops the whole run on a lost sign-in, keeping what was saved", async () => {
	const events = [];
	const saved = [];
	await assert.rejects(
		() =>
			runExport({
				accountId: "123456",
				onEvent: (event) => events.push(event),
				post: twoDailyTournaments(2),
				saveTournament: async (tournament) => {
					saved.push(tournament);
				}
			}),
		(error) => error.code === "AUTH_EXPIRED"
	);
	assert.deepEqual(
		saved.map((tournament) => tournament.key),
		["DAILY:9001"]
	);
	assert.equal(
		events.some((event) => event.type === "tournament-failed"),
		false
	);
});

test("does not fall back to other result routes after a lost sign-in", async () => {
	const calls = [];
	const post = (endpoint) => {
		calls.push(endpoint);
		if (endpoint === ENDPOINTS.bpHistory) {
			return {
				data: {
					bridgePointsTournaments: [{ tournamentId: "123", title: "BP" }],
					totalSize: 1
				}
			};
		}
		if (endpoint === ENDPOINTS.tournamentArchives) {
			return { data: { archives: [], totalSize: 0 } };
		}
		throw new ApiError("expired", { code: "AUTH_EXPIRED" });
	};
	await assert.rejects(
		() => exportWith(post),
		(error) => error.code === "AUTH_EXPIRED"
	);
	assert.equal(calls.includes(ENDPOINTS.knockoutMatches), false);
});

test("cancels between requests when asked to stop", async () => {
	let stop = false;
	const seen = [];
	const { result, saved } = await exportWith(twoDailyTournaments(0), {
		onEvent(event) {
			seen.push(event.type);
			if (event.type === "tournament-saved") {
				stop = true;
			}
		},
		shouldStop: () => stop
	});
	assert.deepEqual(result, { cancelled: true });
	assert.equal(saved.length, 1);
	assert.equal(seen.at(-1), "cancelled");
});

test("stops when a file cannot be saved", async () => {
	await assert.rejects(
		() =>
			exportWith(stubApi().post, {
				saveTournament: async () => {
					throw new Error("disk full");
				}
			}),
		(error) => {
			assert.equal(error.code, "SAVE_FAILED");
			assert.match(error.message, /disk full/);
			return true;
		}
	);
});
