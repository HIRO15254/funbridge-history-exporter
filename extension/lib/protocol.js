export const API_MARKER = "/funbridge-server-ws/rest/";

export const ENDPOINTS = Object.freeze({
	bpHistory: "bridgePoints/historic",
	dealSummary: "result/getDealResultSummary",
	dealGroups: "result/getResultForDeal",
	knockoutMatch: "tournament/getKnockoutTournamentMatch",
	knockoutMatches: "tournament/getKnockoutPlayerMatches",
	resultTournament: "result/getResultDealForTournament",
	tournamentArchives: "tournament/getTournamentArchives"
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

export function runtimeFetchExpression(root, endpoint, authorization, body) {
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
	const url = new URL(endpoint, rootUrl).toString();
	const options = {
		method: "POST",
		headers: {
			Accept: "application/json",
			Authorization: authorization,
			"Content-Type": "application/json"
		},
		body: JSON.stringify(body)
	};
	return `fetch(${JSON.stringify(url)},${JSON.stringify(options)}).then(async response=>({status:response.status,text:await response.text()}))`;
}

export function unwrapApiResult(result, endpoint) {
	const value = result?.result?.value;
	if (result?.exceptionDetails || !value) {
		throw new Error(`${endpoint}: in-page fetch failed.`);
	}
	let json;
	try {
		json = JSON.parse(value.text);
	} catch {
		throw new Error(`${endpoint}: response is not JSON.`);
	}
	if (value.status !== 200 || json?.exception) {
		const reason =
			json?.exception?.message ?? json?.message ?? `HTTP ${value.status}`;
		throw new Error(`${endpoint}: ${reason}`);
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

const tournamentId = (row) =>
	row?.sourceTournamentId ??
	row?.tournamentID ??
	row?.tourIDstr ??
	row?.id ??
	row?.ID;

export function archivePage(payload) {
	const candidates = [];
	visitObjects(payload, (parent) => {
		for (const value of Object.values(parent)) {
			if (!Array.isArray(value) || value.length === 0) {
				continue;
			}
			const score = value.reduce(
				(total, row) => total + (tournamentId(row) === undefined ? 0 : 1),
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
	let found;
	visitObjects(payload, (value) => {
		if (!found && Array.isArray(value.listResultDeal) && value.tournament) {
			found = value;
		}
	});
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
