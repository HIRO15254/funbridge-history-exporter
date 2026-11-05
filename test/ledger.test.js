import assert from "node:assert/strict";
import test from "node:test";
import {
	clearLedger,
	completedKeys,
	loadLedger,
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

test("records a tournament only when every file of it was saved and it is finished", () => {
	const files = [
		{ ledgerKey: "BP_CIRCUIT:9", complete: true, path: "bic-a.pbn" },
		{ ledgerKey: "BP_CIRCUIT:9", complete: true, path: "bic-b.pbn" },
		{ ledgerKey: "DAILY:1", complete: true, path: "d1.pbn" },
		{ ledgerKey: "DAILY:2", complete: false, path: "d2.pbn" }
	];
	assert.deepEqual(
		completedKeys(files, new Set(["bic-a.pbn", "d1.pbn", "d2.pbn"])),
		[["DAILY:1", ["d1.pbn"]]]
	);
	assert.deepEqual(
		completedKeys(files, new Set(["bic-a.pbn", "bic-b.pbn"])).map(
			([key]) => key
		),
		["BP_CIRCUIT:9"]
	);
});
