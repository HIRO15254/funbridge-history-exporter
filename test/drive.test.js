import assert from "node:assert/strict";
import test from "node:test";
import {
	authUrl,
	createDriveClient,
	DriveError,
	driveFolderUrl,
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
		} else if (parsed.pathname.startsWith("/upload/drive/v3/files/")) {
			const id = parsed.pathname.split("/").at(-1);
			files.find((file) => file.id === id).text = options.body;
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
		await drive.save("funbridge-export/daily/a.pbn", "x"),
		"uploaded"
	);
	assert.equal(await drive.save("funbridge-export/daily/a.pbn", "x"), "exists");
	assert.equal(
		await drive.save("funbridge-export/daily/b.pbn", "y"),
		"uploaded"
	);
	assert.deepEqual(
		fake.files.map((f) => f.name),
		["funbridge-export", "daily", "a.pbn", "b.pbn"]
	);
	assert.equal(
		await drive.save("funbridge-export/daily/a.pbn", "x2", { replace: true }),
		"updated"
	);
	assert.equal(fake.files.find((f) => f.name === "a.pbn").text, "x2");
	assert.equal(
		fake.calls.filter(
			(call) => call.path === "/drive/v3/files" && call.method === "POST"
		).length,
		2,
		"each folder is created once"
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
		() => drive.save("a/b.pbn", "x"),
		(error) => {
			assert.ok(error instanceof DriveError);
			assert.equal(error.status, 403);
			assert.match(error.message, /Google Drive: Insufficient Permission/);
			return true;
		}
	);
});

test("builds the sign-in URL and reads the token from the redirect", () => {
	const url = new URL(authUrl("cid", "https://abc.chromiumapp.org/"));
	assert.equal(url.searchParams.get("client_id"), "cid");
	assert.equal(url.searchParams.get("response_type"), "token");
	assert.match(url.searchParams.get("scope"), /drive\.file$/);
	assert.equal(url.searchParams.get("prompt"), null);
	assert.deepEqual(
		tokenFromRedirect(
			"https://abc.chromiumapp.org/#access_token=xyz&token_type=Bearer&expires_in=3599",
			1000
		),
		{ expiresAt: 1000 + 3539 * 1000, token: "xyz" }
	);
	assert.equal(
		driveFolderUrl("abc"),
		"https://drive.google.com/drive/folders/abc"
	);
	assert.throws(
		() => tokenFromRedirect("https://abc.chromiumapp.org/#error=access_denied"),
		/access_denied/
	);
});
