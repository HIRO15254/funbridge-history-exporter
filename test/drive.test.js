import assert from "node:assert/strict";
import test from "node:test";
import {
	authUrl,
	createDriveClient,
	tokenFromRedirect
} from "../extension/lib/drive.js";

function fakeDrive() {
	const files = [];
	const calls = [];
	let nextId = 1;
	const fetchImpl = async (url, options = {}) => {
		const parsed = new URL(url);
		calls.push({ method: options.method ?? "GET", path: parsed.pathname });
		assert.equal(options.headers.Authorization, "Bearer t0k");
		let body = {};
		if (parsed.pathname === "/drive/v3/files" && !options.method) {
			const q = parsed.searchParams.get("q");
			const name = /name = '([^']*)'/.exec(q)[1];
			const parent = /'([^']*)' in parents/.exec(q)[1];
			body = {
				files: files.filter((f) => f.name === name && f.parent === parent)
			};
		} else if (parsed.pathname === "/drive/v3/files") {
			const meta = JSON.parse(options.body);
			const id = `id${nextId++}`;
			files.push({ id, name: meta.name, parent: meta.parents[0] });
			body = { id };
		} else if (parsed.pathname === "/upload/drive/v3/files") {
			const meta = JSON.parse(options.body.split("\r\n")[3]);
			const id = `id${nextId++}`;
			files.push({ id, name: meta.name, parent: meta.parents[0] });
			body = { id };
		}
		return { ok: true, status: 200, text: async () => JSON.stringify(body) };
	};
	return { calls, files, fetchImpl };
}

test("creates the folder path once and skips a file that is already there", async () => {
	const fake = fakeDrive();
	const drive = createDriveClient({ token: "t0k", fetchImpl: fake.fetchImpl });
	assert.equal(
		await drive.saveIfMissing("funbridge-export/daily/a.pbn", "x"),
		"uploaded"
	);
	assert.equal(
		await drive.saveIfMissing("funbridge-export/daily/a.pbn", "x"),
		"exists"
	);
	assert.equal(
		await drive.saveIfMissing("funbridge-export/daily/b.pbn", "y"),
		"uploaded"
	);
	assert.deepEqual(
		fake.files.map((f) => f.name),
		["funbridge-export", "daily", "a.pbn", "b.pbn"]
	);
});

test("reports a Drive error with Google's message", async () => {
	const drive = createDriveClient({
		token: "t0k",
		fetchImpl: async () => ({
			ok: false,
			status: 403,
			text: async () => '{"error":{"message":"Insufficient Permission"}}'
		})
	});
	await assert.rejects(
		() => drive.saveIfMissing("a/b.pbn", "x"),
		/Google Drive: Insufficient Permission/
	);
});

test("builds the sign-in URL and reads the token from the redirect", () => {
	const url = new URL(authUrl("cid", "https://abc.chromiumapp.org/"));
	assert.equal(url.searchParams.get("client_id"), "cid");
	assert.equal(url.searchParams.get("response_type"), "token");
	assert.match(url.searchParams.get("scope"), /drive\.file$/);
	assert.equal(
		tokenFromRedirect(
			"https://abc.chromiumapp.org/#access_token=xyz&token_type=Bearer"
		),
		"xyz"
	);
	assert.throws(
		() => tokenFromRedirect("https://abc.chromiumapp.org/#error=access_denied"),
		/access_denied/
	);
});
