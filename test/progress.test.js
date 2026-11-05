import assert from "node:assert/strict";
import test from "node:test";
import {
	badgeFor,
	fractionDone,
	isActive,
	LOG_LIMIT,
	newRun,
	reduceRun,
	remainingMs,
	runSummary
} from "../extension/lib/progress.js";

function play(events, start = 1000) {
	let run = newRun({ id: "r1", startedAt: start });
	let at = start;
	for (const event of events) {
		at += 1000;
		run = reduceRun(run, event, at);
	}
	return run;
}

const daily = { family: "DAILY", key: "DAILY:1", title: "ASIA" };

test("follows a run from listing to done", () => {
	const listed = play([
		{ family: "BP_CIRCUIT", type: "listing" },
		{ count: 2, family: "BP_CIRCUIT", type: "listed" },
		{ family: "SERIES", type: "listing" },
		{ family: "SERIES", reason: "HTTP 404", type: "list-failed" },
		{ family: "DAILY", type: "listing" }
	]);
	assert.equal(listed.status, "listing");
	assert.equal(listed.families.BP_CIRCUIT.found, 2);
	assert.equal(listed.families.SERIES.state, "unavailable");
	assert.equal(listed.families.DAILY.state, "listing");
	assert.equal(badgeFor(listed).text, "…");

	const run = play([
		{ count: 3, family: "DAILY", type: "listed" },
		{
			already: { BP_CIRCUIT: 0, DAILY: 1, SERIES: 0 },
			found: { BP_CIRCUIT: 0, DAILY: 3, SERIES: 0 },
			toFetch: 2,
			type: "plan"
		},
		{ ...daily, index: 0, type: "tournament-start" },
		{ board: 2, boards: 4, type: "board" }
	]);
	assert.equal(run.status, "saving");
	assert.equal(run.counts.already, 1);
	assert.equal(run.current.board, 2);
	assert.equal(fractionDone(run), 0.25);
	assert.equal(badgeFor(run).text, "0/2");
	assert.equal(isActive(run), true);

	const finished = [
		{
			...daily,
			boards: 4,
			drive: "uploaded",
			files: 1,
			type: "tournament-saved"
		},
		{ ...daily, key: "DAILY:2", index: 1, type: "tournament-start" },
		{ ...daily, key: "DAILY:2", reason: "boom", type: "tournament-failed" },
		{ type: "done" }
	].reduce(
		(state, event, index) => reduceRun(state, event, 10_000 + index),
		run
	);
	assert.equal(finished.status, "done");
	assert.equal(finished.processed, 2);
	assert.deepEqual(
		{
			boards: finished.counts.boards,
			driveUploaded: finished.counts.driveUploaded,
			failed: finished.counts.failed,
			saved: finished.counts.saved
		},
		{ boards: 4, driveUploaded: 1, failed: 1, saved: 1 }
	);
	assert.equal(finished.families.DAILY.saved, 1);
	assert.equal(finished.families.DAILY.failed, 1);
	assert.deepEqual(
		finished.log.map((entry) => entry.kind),
		["saved", "failed"]
	);
	assert.equal(finished.current, undefined);
	assert.equal(fractionDone(finished), 1);
	assert.equal(badgeFor(finished).text, "");
	assert.equal(isActive(finished), false);
	assert.deepEqual(runSummary(finished), {
		already: 1,
		boards: 4,
		errorCode: undefined,
		failed: 1,
		finishedAt: 10_003,
		saved: 1,
		startedAt: 1000,
		status: "done"
	});
});

test("ignores events that arrive after the run finished", () => {
	const run = play([{ code: "NO_TAB", message: "x", type: "failed" }]);
	assert.equal(run.status, "failed");
	assert.deepEqual(run.error, { code: "NO_TAB", message: "x" });
	assert.equal(reduceRun(run, { type: "done" }), run);
	assert.equal(badgeFor(run).text, "!");
});

test("pauses for a new sign-in and resumes where it was", () => {
	const run = play([
		{ already: {}, found: {}, toFetch: 3, type: "plan" },
		{ type: "waiting-sign-in" },
		{ type: "waiting-sign-in" }
	]);
	assert.equal(run.status, "waiting-sign-in");
	assert.equal(badgeFor(run).text, "!");
	assert.equal(run.log.length, 1);
	const resumed = reduceRun(run, { type: "signed-in-again" });
	assert.equal(resumed.status, "saving");
	assert.deepEqual(
		resumed.log.map((entry) => entry.kind),
		["sign-in-lost", "sign-in-back"]
	);
});

test("caps the log but keeps every failure", () => {
	const events = [{ already: {}, found: {}, toFetch: 1000, type: "plan" }];
	for (let index = 0; index < LOG_LIMIT + 50; index++) {
		events.push({
			...daily,
			reason: "x",
			type: index % 10 === 0 ? "tournament-failed" : "tournament-saved"
		});
	}
	const run = play(events);
	assert.equal(run.log.length, LOG_LIMIT);
	assert.equal(
		run.log.filter((entry) => entry.kind === "failed").length,
		(LOG_LIMIT + 50) / 10
	);
	assert.equal(run.processed, LOG_LIMIT + 50);
});

test("estimates the time left from the pace so far", () => {
	let run = newRun({ id: "r", startedAt: 0 });
	run = reduceRun(
		run,
		{ already: {}, found: {}, toFetch: 10, type: "plan" },
		0
	);
	run = reduceRun(run, { ...daily, type: "tournament-saved" }, 1000);
	assert.equal(remainingMs(run, 1000), undefined);
	run = reduceRun(run, { ...daily, type: "tournament-saved" }, 2000);
	assert.equal(remainingMs(run, 2000), 8000);
});

test("shows a percentage on the badge when the count does not fit", () => {
	let run = newRun({ id: "r", startedAt: 0 });
	run = reduceRun(run, { already: {}, found: {}, toFetch: 400, type: "plan" });
	for (let index = 0; index < 100; index++) {
		run = reduceRun(run, { ...daily, type: "tournament-saved" });
	}
	assert.equal(badgeFor(run).text, "25%");
});
