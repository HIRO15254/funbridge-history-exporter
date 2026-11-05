import assert from "node:assert/strict";
import test from "node:test";
import {
	clearLedger,
	isSavedTo,
	ledgerSize,
	loadLedger,
	recordSaved,
	saveLedger
} from "../extension/lib/ledger.js";

function memoryArea() {
	const data = {};
	return {
		data,
		get: async (key) => ({ [key]: data[key] }),
		set: async (values) => Object.assign(data, values),
		remove: async (key) => {
			delete data[key];
		}
	};
}

test("round-trips the ledger and starts empty when storage fails", async () => {
	const area = memoryArea();
	assert.deepEqual(await loadLedger(area), {});
	await saveLedger(area, { "DAILY:1": { paths: ["a.pbn"] } });
	assert.deepEqual(await loadLedger(area), { "DAILY:1": { paths: ["a.pbn"] } });
	await clearLedger(area);
	assert.deepEqual(await loadLedger(area), {});
	assert.deepEqual(
		await loadLedger({
			get: async () => {
				throw new Error("no storage");
			}
		}),
		{}
	);
});

test("counts a tournament as saved only for the destinations it reached", async () => {
	const ledger = {};
	recordSaved(ledger, "DAILY:1", {
		destinations: ["downloads"],
		paths: ["d1.pbn"],
		savedAt: "2026-11-05T00:00:00.000Z"
	});
	ledger["DAILY:0"] = { paths: ["old.pbn"] };
	assert.equal(isSavedTo(ledger, ["downloads"])("DAILY:1"), true);
	assert.equal(isSavedTo(ledger, ["downloads"])("DAILY:0"), true);
	assert.equal(isSavedTo(ledger, ["downloads", "drive"])("DAILY:1"), false);
	assert.equal(isSavedTo(ledger, ["downloads"])("DAILY:2"), false);

	recordSaved(ledger, "DAILY:1", {
		destinations: ["drive"],
		paths: ["d1.pbn"],
		savedAt: "2026-11-05T01:00:00.000Z"
	});
	assert.deepEqual(ledger["DAILY:1"].destinations, ["downloads", "drive"]);
	assert.equal(isSavedTo(ledger, ["downloads", "drive"])("DAILY:1"), true);

	const area = memoryArea();
	await saveLedger(area, ledger);
	assert.equal(await ledgerSize(area), 2);
});
