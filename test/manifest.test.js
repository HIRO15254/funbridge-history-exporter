import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const extensionDirectory = path.resolve(
	path.dirname(fileURLToPath(import.meta.url)),
	"..",
	"extension"
);
const read = (relativePath) =>
	fs.readFileSync(path.join(extensionDirectory, relativePath), "utf8");
const manifest = JSON.parse(read("manifest.json"));

test("stays a Manifest V3 extension with the minimum permission set", () => {
	assert.equal(manifest.manifest_version, 3);
	assert.deepEqual([...manifest.permissions].sort(), [
		"activeTab",
		"debugger",
		"downloads"
	]);
	assert.deepEqual(manifest.host_permissions, [
		"https://*.funbridge.com/*",
		"https://*.funbridge.net/*"
	]);
});

test("ships every file the manifest and the popup reference", () => {
	for (const relativePath of [
		manifest.background.service_worker,
		manifest.action.default_popup,
		"popup.js",
		"popup.css",
		"lib/exporter.js",
		"lib/pbn.js",
		"lib/protocol.js"
	]) {
		assert.ok(
			fs.existsSync(path.join(extensionDirectory, relativePath)),
			`missing extension asset: ${relativePath}`
		);
	}
});

test("keeps credentials out of storage and out of the console", () => {
	const background = read("background.js");
	assert.equal(
		background.includes("chrome.storage"),
		false,
		"credentials must not be written to chrome.storage"
	);
	assert.equal(
		background.includes("console."),
		false,
		"network responses or credentials must not be logged"
	);
});

test("downloads the export as PBN rather than JSON", () => {
	const background = read("background.js");
	assert.match(background, /data:application\/x-pbn;charset=utf-8/);
	assert.equal(background.includes("application/json;charset=utf-8"), false);
});
