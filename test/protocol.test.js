import assert from "node:assert/strict";
import test from "node:test";
import {
	authorizationFrom,
	describeObservedCall,
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

test("explains a non-JSON response with its status, type and a short body", () => {
	assert.throws(
		() =>
			unwrapApiResult(
				{
					result: {
						value: {
							contentType: "text/html;charset=utf-8",
							status: 400,
							text: "<html><body><h1>HTTP Status 400 – Bad Request</h1></body></html>"
						}
					}
				},
				"result/getTournamentArchives"
			),
		/not JSON \(HTTP 400, text\/html, body: "HTTP Status 400 – Bad Request"\)/
	);
});

test("treats an empty successful body as an empty payload", () => {
	assert.deepEqual(
		unwrapApiResult({ result: { value: { status: 200, text: "" } } }, "x"),
		{}
	);
	assert.throws(
		() =>
			unwrapApiResult({ result: { value: { status: 401, text: "" } } }, "x"),
		/HTTP 401, empty body/
	);
});

test("describes an observed Funbridge call by host, path and body keys only", () => {
	assert.equal(
		describeObservedCall(
			`${root}/tournament/getArchives`,
			'{"offset":0,"categoryID":6,"nbMax":20}'
		),
		"example.funbridge.net/tournament/getArchives {categoryID,nbMax,offset}"
	);
	assert.equal(
		describeObservedCall(`${root}/${ENDPOINTS.bpHistory}`),
		`example.funbridge.net/${ENDPOINTS.bpHistory}`
	);
	assert.equal(describeObservedCall("https://example.invalid/x"), undefined);
});

test("reads the archive list in the shape result/getTournamentArchives returns", async () => {
	const { archivePage } = await import("../extension/lib/protocol.js");
	const page = archivePage({
		exception: null,
		data: {
			offset: 0,
			totalSize: 2,
			archives: [
				{ categoryID: 6, tournamentID: "11457", listPlayedDeals: ["1", "2"] },
				{ categoryID: 6, tournamentID: "11458", listPlayedDeals: ["3"] }
			],
			nbQualifTournaments: 0
		}
	});
	assert.equal(page.rows.length, 2);
	assert.equal(page.totalSize, 2);
	assert.equal(page.offset, 0);
});
