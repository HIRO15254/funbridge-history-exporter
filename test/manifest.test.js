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
const withoutComments = (source) =>
	source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

test("stays a Manifest V3 extension with the minimum permission set", () => {
	assert.equal(manifest.manifest_version, 3);
	assert.deepEqual([...manifest.permissions].sort(), [
		"downloads",
		"downloads.ui",
		"identity",
		"notifications",
		"scripting",
		"storage",
		"webRequest"
	]);
	assert.deepEqual(manifest.host_permissions, [
		"https://*.funbridge.com/*",
		"https://*.funbridge.net/*",
		"https://www.googleapis.com/*"
	]);
	assert.equal(manifest.options_ui.page, "options.html");
});

test("ships every file the manifest and the pages reference", () => {
	const pages = [
		manifest.action.default_popup,
		manifest.options_ui.page,
		"progress.html"
	];
	const referenced = pages.flatMap((page) =>
		[...read(page).matchAll(/(?:src|href)="([^"#:]+)"/g)].map(
			([, reference]) => reference
		)
	);
	for (const relativePath of [
		manifest.background.service_worker,
		...pages,
		...referenced,
		...Object.values(manifest.icons)
	]) {
		assert.ok(
			fs.existsSync(path.join(extensionDirectory, relativePath)),
			`missing extension asset: ${relativePath}`
		);
	}
});

test("keeps credentials off disk and out of the console", () => {
	for (const file of ["lib/ledger.js", "lib/settings.js"]) {
		assert.equal(
			/authorization|token|bearer/i.test(withoutComments(read(file))),
			false,
			`${file} writes chrome.storage.local and must never hold sign-in data`
		);
	}
	const background = read("background.js");
	for (const forbidden of [
		"storage.local.set",
		"storage.sync",
		"localStorage"
	]) {
		assert.equal(
			background.includes(forbidden),
			false,
			`the background worker must not use ${forbidden}`
		);
	}
	for (const file of [
		"background.js",
		"lib/capture.js",
		"lib/exporter.js",
		"lib/drive.js",
		"lib/protocol.js",
		"popup.js",
		"options.js",
		"progress.js"
	]) {
		assert.equal(
			read(file).includes("console."),
			false,
			`${file} must not log responses or credentials`
		);
	}
});

test("never puts the sign-in into the run state the pages read", () => {
	const progress = withoutComments(read("lib/progress.js"));
	assert.equal(/authorization|token/i.test(progress), false);
});

test("downloads the export as PBN rather than JSON", () => {
	const background = read("background.js");
	assert.match(background, /data:application\/x-pbn;charset=utf-8/);
	assert.equal(background.includes("application/json;charset=utf-8"), false);
});

function localeMessages(locale) {
	return JSON.parse(read(`_locales/${locale}/messages.json`));
}

const placeholders = (message) =>
	[...message.matchAll(/\$(\d)/g)].map(([, digit]) => digit).sort();

test("has every message in English and Japanese with the same placeholders", () => {
	const english = localeMessages("en");
	const japanese = localeMessages("ja");
	assert.deepEqual(Object.keys(japanese).sort(), Object.keys(english).sort());
	for (const [key, { message }] of Object.entries(english)) {
		assert.deepEqual(
			placeholders(japanese[key].message),
			placeholders(message),
			`placeholders differ for ${key}`
		);
	}
});

test("defines every message the code and pages use", () => {
	const english = localeMessages("en");
	const sources = [
		"background.js",
		"popup.js",
		"options.js",
		"progress.js",
		"ui/common.js",
		"ui/run-text.js",
		"lib/hints.js"
	].map(read);
	const used = new Set();
	for (const source of sources) {
		for (const [, key] of source.matchAll(/\bt\(\s*"(\w+)"/g)) {
			used.add(key);
		}
		for (const [, key] of source.matchAll(/:\s*"((?:hint|status)[A-Z]\w+)"/g)) {
			used.add(key);
		}
		// t(condition ? "oneKey" : "otherKey")
		for (const [, first, second] of source.matchAll(
			/\bt\([^()]*?\?\s*"(\w+)"\s*:\s*"(\w+)"\s*\)/g
		)) {
			used.add(first);
			used.add(second);
		}
	}
	for (const page of ["popup.html", "options.html", "progress.html"]) {
		for (const [, key] of read(page).matchAll(/data-i18n(?:-\w+)?="(\w+)"/g)) {
			used.add(key);
		}
	}
	for (const family of ["BP_CIRCUIT", "SERIES", "DAILY"]) {
		used.add(`family_${family}`);
	}
	for (const key of used) {
		assert.ok(english[key], `missing message: ${key}`);
	}
	for (const value of Object.values(manifest).filter(
		(entry) => typeof entry === "string"
	)) {
		const match = /^__MSG_(\w+)__$/.exec(value);
		if (match) {
			assert.ok(english[match[1]], `missing manifest message: ${match[1]}`);
		}
	}
});
