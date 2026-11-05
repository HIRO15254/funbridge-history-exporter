import assert from "node:assert/strict";
import test from "node:test";
import {
	decodeRequestBody,
	headersToObject,
	SessionStore
} from "../extension/lib/capture.js";
import { ENDPOINTS } from "../extension/lib/protocol.js";

const root = "https://fb3.funbridge.net/funbridge-server-ws/rest";
const encode = (text) => ({
	raw: [{ bytes: new TextEncoder().encode(text).buffer }]
});

function call(store, { tabId = 7, endpoint, body, authorization, requestId }) {
	const url = `${root}/${endpoint}`;
	store.noteRequest({
		requestBody: body === undefined ? undefined : encode(JSON.stringify(body)),
		requestId,
		tabId,
		url
	});
	store.noteHeaders({
		requestHeaders: authorization
			? [{ name: "Authorization", value: authorization }]
			: [],
		requestId,
		tabId,
		url
	});
}

test("decodes request bodies and header lists", () => {
	assert.equal(decodeRequestBody(encode('{"a":1}')), '{"a":1}');
	assert.equal(decodeRequestBody(undefined), undefined);
	assert.deepEqual(
		headersToObject([
			{ name: "A", value: "1" },
			{ name: "B" },
			{ value: "no name" }
		]),
		{ A: "1", B: "" }
	);
});

test("learns the sign-in and request templates from the page's own calls", () => {
	let clock = 100;
	const store = new SessionStore({ now: () => clock });
	const changes = [];
	store.onChange((tabId) => changes.push(tabId));

	call(store, {
		authorization: "Bearer one",
		endpoint: "player/getProfile",
		requestId: "1"
	});
	const session = store.ready();
	assert.equal(session.tabId, 7);
	assert.equal(session.apiRoot, root);
	assert.equal(session.authVersion, 1);
	assert.deepEqual(changes, [7]);
	assert.deepEqual(
		[...session.observedCalls],
		["fb3.funbridge.net/player/getProfile"]
	);

	clock = 200;
	call(store, {
		authorization: "Bearer one",
		body: { categoryID: 6, count: 20, offset: 0 },
		endpoint: ENDPOINTS.tournamentArchives,
		requestId: "2"
	});
	assert.equal(session.authVersion, 1, "the same sign-in is not a change");
	assert.equal(session.authorizedAt, 200);
	assert.deepEqual(
		session.templates[`${ENDPOINTS.tournamentArchives}#6`].body,
		{ categoryID: 6, count: 20, offset: 0 }
	);

	call(store, {
		authorization: "Bearer two",
		endpoint: "player/getProfile",
		requestId: "3"
	});
	assert.equal(session.authVersion, 2);
	assert.deepEqual(changes, [7, 7]);
});

test("does not learn templates from its own calls during an export", () => {
	const store = new SessionStore();
	call(store, {
		authorization: "Bearer one",
		endpoint: "player/getProfile",
		requestId: "1"
	});
	const session = store.ready();
	session.exporting = true;
	call(store, {
		authorization: "Bearer two",
		body: { categoryID: 8 },
		endpoint: ENDPOINTS.tournamentArchives,
		requestId: "2"
	});
	assert.deepEqual(session.templates, {});
	assert.equal(session.authorization, "Bearer two");
});

test("ignores calls outside Funbridge or outside a tab", () => {
	const store = new SessionStore();
	store.noteHeaders({
		requestHeaders: [{ name: "Authorization", value: "Bearer x" }],
		tabId: 1,
		url: "https://example.com/funbridge-server-ws/rest/x"
	});
	call(store, {
		authorization: "Bearer x",
		endpoint: "player/getProfile",
		requestId: "1",
		tabId: -1
	});
	assert.equal(store.ready(), undefined);
});

test("prefers the asked-for tab, else the most recently signed-in one", () => {
	let clock = 1;
	const store = new SessionStore({ now: () => clock++ });
	call(store, {
		authorization: "Bearer a",
		endpoint: "x/y",
		requestId: "1",
		tabId: 1
	});
	call(store, {
		authorization: "Bearer b",
		endpoint: "x/y",
		requestId: "2",
		tabId: 2
	});
	assert.equal(store.ready().tabId, 2);
	assert.equal(store.ready(1).tabId, 1);
	assert.equal(store.ready(3).tabId, 2);
	store.forgetTab(2);
	assert.equal(store.ready().tabId, 1);
});

test("restores a snapshot without overwriting newer sessions", () => {
	const store = new SessionStore();
	call(store, {
		authorization: "Bearer a",
		endpoint: "x/y",
		requestId: "1",
		tabId: 1
	});
	store.ready().templates.t = { body: {} };
	const snapshot = JSON.parse(JSON.stringify(store.snapshot()));

	const fresh = new SessionStore();
	call(fresh, {
		authorization: "Bearer new",
		endpoint: "x/y",
		requestId: "9",
		tabId: 1
	});
	call(fresh, { endpoint: "x/y", requestId: "8", tabId: 5 });
	fresh.restore([
		...snapshot,
		{ ...snapshot[0], authorization: "Bearer other", tabId: 4 }
	]);
	assert.equal(fresh.sessions.get(1).authorization, "Bearer new");
	assert.equal(fresh.sessions.get(4).authorization, "Bearer other");
	assert.deepEqual(fresh.sessions.get(4).templates, { t: { body: {} } });
	assert.equal(
		fresh.snapshot().some((session) => session.tabId === 5),
		false,
		"tabs without a sign-in are not kept"
	);
	fresh.restore("garbage");
});

test("waits for a different sign-in, a timeout, or a stop", async () => {
	let clock = 0;
	const store = new SessionStore({ now: () => clock });
	const sleep = async (ms) => {
		clock += ms;
		if (clock === 1500) {
			call(store, {
				authorization: "Bearer new",
				endpoint: "x/y",
				requestId: "1",
				tabId: 3
			});
		}
	};
	assert.equal(
		await store.waitForNewAuthorization(3, 0, { sleep, timeoutMs: 10_000 }),
		true
	);
	assert.equal(clock, 1500);
	assert.equal(
		await store.waitForNewAuthorization(3, 1, { sleep, timeoutMs: 2000 }),
		false
	);
	assert.equal(
		await store.waitForNewAuthorization(3, 1, {
			sleep,
			stop: () => true,
			timeoutMs: 2000
		}),
		false
	);
});
