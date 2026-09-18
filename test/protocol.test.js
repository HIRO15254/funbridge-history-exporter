import assert from "node:assert/strict";
import test from "node:test";
import {
	authorizationFrom,
	ENDPOINTS,
	isFunbridgePage,
	parseApiUrl,
	parsePostData,
	runtimeFetchExpression,
	unwrapApiResult
} from "../extension/lib/protocol.js";

const root = "https://example.funbridge.net/funbridge-server-ws/rest";

test("accepts only the Funbridge API endpoints the project has observed", () => {
	assert.deepEqual(parseApiUrl(`${root}/${ENDPOINTS.tournamentArchives}`), {
		endpoint: ENDPOINTS.tournamentArchives,
		root
	});
	assert.equal(parseApiUrl(`${root}/account/updateProfile`), undefined);
	assert.equal(
		parseApiUrl(
			`https://example.invalid/funbridge-server-ws/rest/${ENDPOINTS.tournamentArchives}`
		),
		undefined
	);
	assert.equal(parseApiUrl("not a url"), undefined);
});

test("recognises Funbridge pages over https only", () => {
	assert.equal(isFunbridgePage("https://www.funbridge.com/play"), true);
	assert.equal(isFunbridgePage("http://www.funbridge.com/play"), false);
	assert.equal(isFunbridgePage("https://funbridge.com.invalid/"), false);
});

test("refuses to build a fetch for an endpoint or host outside the allowlist", () => {
	assert.match(
		runtimeFetchExpression(
			root,
			ENDPOINTS.tournamentArchives,
			"Bearer test-only",
			{ categoryID: 6 }
		),
		/^fetch\(/
	);
	assert.throws(() =>
		runtimeFetchExpression(
			root,
			"account/updateProfile",
			"Bearer test-only",
			{}
		)
	);
	assert.throws(() =>
		runtimeFetchExpression(
			"https://example.invalid/rest",
			ENDPOINTS.tournamentArchives,
			"Bearer test-only",
			{}
		)
	);
});

test("reads the Authorization header whatever its casing", () => {
	assert.equal(authorizationFrom({ authorization: "Bearer x" }), "Bearer x");
	assert.equal(authorizationFrom({ Authorization: "Bearer x" }), "Bearer x");
	assert.equal(authorizationFrom({}), undefined);
	assert.equal(authorizationFrom(), undefined);
});

test("treats an unparsable POST body as an empty template", () => {
	assert.deepEqual(parsePostData('{"categoryID":6}'), { categoryID: 6 });
	assert.deepEqual(parsePostData("[1,2]"), {});
	assert.deepEqual(parsePostData("not json"), {});
	assert.deepEqual(parsePostData(), {});
});

test("surfaces the API error instead of the raw response body", () => {
	assert.deepEqual(
		unwrapApiResult(
			{ result: { value: { status: 200, text: '{"a":1}' } } },
			"x"
		),
		{ a: 1 }
	);
	assert.throws(
		() =>
			unwrapApiResult(
				{ result: { value: { status: 500, text: '{"message":"boom"}' } } },
				"x"
			),
		/boom/
	);
	assert.throws(
		() =>
			unwrapApiResult(
				{ result: { value: { status: 200, text: "<html>" } } },
				"x"
			),
		/JSON/
	);
	assert.throws(() => unwrapApiResult({ exceptionDetails: {} }, "x"));
});
