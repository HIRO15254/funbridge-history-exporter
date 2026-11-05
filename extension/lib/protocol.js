export const API_MARKER = "/funbridge-server-ws/rest/";

export const ENDPOINTS = Object.freeze({
	bpHistory: "bridgePoints/historic",
	dealSummary: "result/getDealResultSummary",
	dealGroups: "result/getResultForDeal",
	knockoutMatch: "tournament/getKnockoutTournamentMatch",
	knockoutMatches: "tournament/getKnockoutPlayerMatches",
	resultTournament: "result/getResultDealForTournament",
	tournamentArchives: "result/getTournamentArchives"
});

const endpointSet = new Set(Object.values(ENDPOINTS));
const numericIdPattern = /^\d+$/;

export function isFunbridgePage(url) {
	try {
		const { hostname, protocol } = new URL(url);
		return (
			protocol === "https:" &&
			(hostname === "funbridge.com" || hostname.endsWith(".funbridge.com"))
		);
	} catch {
		return false;
	}
}

export function parseApiUrl(url) {
	try {
		const parsed = new URL(url);
		const markerIndex = parsed.pathname.indexOf(API_MARKER);
		if (
			parsed.protocol !== "https:" ||
			!parsed.hostname.endsWith(".funbridge.net") ||
			markerIndex < 0
		) {
			return undefined;
		}
		const endpoint = parsed.pathname.slice(markerIndex + API_MARKER.length);
		if (!endpointSet.has(endpoint)) {
			return undefined;
		}
		return {
			endpoint,
			root: `${parsed.origin}${parsed.pathname.slice(0, markerIndex + API_MARKER.length - 1)}`
		};
	} catch {
		return undefined;
	}
}

// Names only (host and path after the REST marker, plus POST body keys), so a
// failed export can say which Funbridge APIs the page really used. No values.
export function describeObservedCall(url, postData) {
	try {
		const parsed = new URL(url);
		const markerIndex = parsed.pathname.indexOf(API_MARKER);
		if (
			parsed.protocol !== "https:" ||
			!parsed.hostname.endsWith(".funbridge.net") ||
			markerIndex < 0
		) {
			return undefined;
		}
		const path = parsed.pathname.slice(markerIndex + API_MARKER.length);
		const keys = Object.keys(parsePostData(postData)).sort();
		return `${parsed.hostname}/${path}${keys.length ? ` {${keys.join(",")}}` : ""}`;
	} catch {
		return undefined;
	}
}

export function authorizationFrom(headers = {}) {
	const key = Object.keys(headers).find(
		(name) => name.toLowerCase() === "authorization"
	);
	const value = key ? headers[key] : undefined;
	return typeof value === "string" && value.length > 0 ? value : undefined;
}

export function parsePostData(value) {
	if (!value) {
		return {};
	}
	try {
		const parsed = JSON.parse(value);
		return parsed && typeof parsed === "object" && !Array.isArray(parsed)
			? parsed
			: {};
	} catch {
		return {};
	}
}

// The REST root of any Funbridge API URL, allowlisted or not. Every call the
// page makes carries the same Authorization header, so any of them is enough
// to pick up the signed-in session.
export function apiRootFromUrl(url) {
	try {
		const parsed = new URL(url);
		const markerIndex = parsed.pathname.indexOf(API_MARKER);
		if (
			parsed.protocol !== "https:" ||
			!parsed.hostname.endsWith(".funbridge.net") ||
			markerIndex < 0
		) {
			return undefined;
		}
		return `${parsed.origin}${parsed.pathname.slice(0, markerIndex + API_MARKER.length - 1)}`;
	} catch {
		return undefined;
	}
}

// The URL and fetch options for one allowlisted call, run inside the
// Funbridge tab so cookies and origin are the page's own.
export function buildApiRequest(root, endpoint, authorization, body) {
	if (!endpointSet.has(endpoint)) {
		throw new Error(`Funbridge API not allowed: ${endpoint}`);
	}
	const rootUrl = new URL(`${root}/`);
	if (
		rootUrl.protocol !== "https:" ||
		!rootUrl.hostname.endsWith(".funbridge.net") ||
		!rootUrl.pathname.endsWith("/rest/")
	) {
		throw new Error("Cannot verify the Funbridge API root.");
	}
	return {
		url: new URL(endpoint, rootUrl).toString(),
		init: {
			method: "POST",
			headers: {
				Accept: "application/json",
				Authorization: authorization,
				"Content-Type": "application/json"
			},
			body: JSON.stringify(body)
		}
	};
}

export class ApiError extends Error {
	constructor(message, { code, detail } = {}) {
		super(message);
		this.name = "ApiError";
		this.code = code;
		this.detail = detail;
	}
}

// Funbridge allows one web session at a time; a sign-in elsewhere ends this
// one with CONNECT_ANOTHER_DEVICE.
const expiredPattern =
	/INVALID_ACCESS_TOKEN|ACCESS_TOKEN_EXPIRED|SESSION_EXPIRED|INVALID_SESSION|CONNECT_ANOTHER_DEVICE/i;

const snippetLength = 160;

function responseSnippet(text) {
	return String(text ?? "")
		.replace(/<[^>]*>/g, " ")
		.replace(/\s+/g, " ")
		.trim()
		.slice(0, snippetLength);
}

function describeNonJson(value) {
	const parts = [`HTTP ${value.status}`];
	if (value.contentType) {
		parts.push(value.contentType.split(";")[0]);
	}
	if (value.redirected) {
		parts.push("redirected");
	}
	const snippet = responseSnippet(value.text);
	parts.push(snippet ? `body: "${snippet}"` : "empty body");
	return parts.join(", ");
}

// Worth one more try after a pause: no answer at all, rate limiting, or a
// server error.
function isTemporaryStatus(status) {
	return status === 0 || status === 429 || status >= 500;
}

function failureCode(status, exception) {
	if (
		status === 401 ||
		expiredPattern.test(
			`${exception?.type ?? ""} ${exception?.message ?? ""} ${exception?.code ?? ""}`
		)
	) {
		return "AUTH_EXPIRED";
	}
	return isTemporaryStatus(status) ? "TEMPORARY" : "API_ERROR";
}

function parseJson(value, endpoint) {
	try {
		return JSON.parse(value.text);
	} catch {
		const code =
			value.status === 401
				? "AUTH_EXPIRED"
				: isTemporaryStatus(value.status)
					? "TEMPORARY"
					: "BAD_RESPONSE";
		throw new ApiError(
			`${endpoint}: response is not JSON (${describeNonJson(value)}).`,
			{ code }
		);
	}
}

// value is what the in-page fetch returned: {status, contentType, redirected,
// text}, or undefined when the script could not run.
export function unwrapApiResult(value, endpoint) {
	if (!value || typeof value.status !== "number") {
		throw new ApiError(
			`${endpoint}: the request could not run in the Funbridge tab.`,
			{ code: "TAB_UNAVAILABLE" }
		);
	}
	const ok = value.status >= 200 && value.status < 300;
	if (ok && String(value.text ?? "").trim() === "") {
		// Funbridge answers some empty lists with no body at all.
		return {};
	}
	const json = parseJson(value, endpoint);
	if (!ok || json?.exception) {
		const exception = json?.exception;
		const reason =
			exception?.message ??
			exception?.type ??
			json?.message ??
			`HTTP ${value.status}`;
		throw new ApiError(`${endpoint}: ${reason}`, {
			code: failureCode(value.status, exception)
		});
	}
	return json;
}

function visitObjects(root, callback) {
	const queue = [root];
	const seen = new Set();
	while (queue.length) {
		const value = queue.shift();
		if (!value || typeof value !== "object" || seen.has(value)) {
			continue;
		}
		seen.add(value);
		callback(value);
		for (const child of Object.values(value)) {
			if (child && typeof child === "object") {
				queue.push(child);
			}
		}
	}
}

// Funbridge names a tournament's ID differently per list: tournamentID in
// archives, tournamentId (with id: null) in BP Circuit history, tourIDstr in
// some results. Every module reads it through this one helper so they cannot
// drift apart. Empty, 0 and -1 mean "no ID".
const tournamentIdKeys = [
	"sourceTournamentId",
	"tournamentID",
	"tourIDstr",
	"tournamentId",
	"id",
	"ID"
];
const missingIds = new Set(["", "0", "-1"]);

export function tournamentIdOf(row) {
	for (const key of tournamentIdKeys) {
		const value = row?.[key];
		if (
			(typeof value === "string" || typeof value === "number") &&
			!missingIds.has(String(value))
		) {
			return String(value);
		}
	}
	return undefined;
}

export function archivePage(payload) {
	const candidates = [];
	visitObjects(payload, (parent) => {
		for (const value of Object.values(parent)) {
			if (!Array.isArray(value) || value.length === 0) {
				continue;
			}
			const score = value.reduce(
				(total, row) => total + (tournamentIdOf(row) === undefined ? 0 : 1),
				0
			);
			if (score > 0) {
				candidates.push({ rows: value, parent, score });
			}
		}
	});
	candidates.sort((a, b) => b.score - a.score || b.rows.length - a.rows.length);
	const best = candidates[0];
	if (!best) {
		return { rows: [], offset: 0, totalSize: 0 };
	}
	return {
		rows: best.rows,
		offset: Number(best.parent.offset ?? 0),
		totalSize: Number(
			best.parent.totalSize ?? best.parent.total ?? best.rows.length
		)
	};
}

export function resultDealTournament(payload) {
	// getResultForDeal answers Daily boards with tournament: null, so a row
	// list on its own is enough; one that also names its tournament wins.
	let found;
	let fallback;
	visitObjects(payload, (value) => {
		if (found || !Array.isArray(value.listResultDeal)) {
			return;
		}
		if (value.tournament) {
			found = value;
		} else {
			fallback ??= value;
		}
	});
	found ??= fallback;
	if (!found) {
		throw new Error("Unrecognized tournament result response shape.");
	}
	return found;
}

export function dealSummary(payload) {
	let found;
	visitObjects(payload?.data ?? payload, (value) => {
		if (!found && value.deal?.playerHands && value.result?.tournament) {
			found = value;
		}
	});
	if (!found) {
		throw new Error("Unrecognized board summary response shape.");
	}
	return found;
}

export function knockoutMatches(payload) {
	let found;
	visitObjects(payload, (value) => {
		if (!found && Array.isArray(value.matchList)) {
			found = value.matchList;
		}
	});
	if (!found) {
		throw new Error("Unrecognized KO match list response shape.");
	}
	return found;
}

export function knockoutMatch(payload) {
	let found;
	visitObjects(payload, (value) => {
		if (!found && value.match && Array.isArray(value.dealList)) {
			found = value;
		}
	});
	if (!found) {
		throw new Error("Unrecognized KO match result response shape.");
	}
	return found;
}

export function findPlayerId(...roots) {
	for (const root of roots) {
		let found;
		visitObjects(root, (value) => {
			if (found) {
				return;
			}
			for (const key of ["playerID", "playerId", "funbridgeId"]) {
				const candidate = value[key];
				if (
					(typeof candidate === "number" || typeof candidate === "string") &&
					numericIdPattern.test(String(candidate)) &&
					Number(candidate) > 0
				) {
					found = String(candidate);
					return;
				}
			}
		});
		if (found) {
			return found;
		}
	}
	return undefined;
}
