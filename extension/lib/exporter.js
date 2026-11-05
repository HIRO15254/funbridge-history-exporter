import { buildTournamentPbn, pbnFileName } from "./pbn.js";
import {
	archivePage,
	dealSummary,
	ENDPOINTS,
	findPlayerId,
	knockoutMatch,
	knockoutMatches,
	resultDealTournament
} from "./protocol.js";

const familyDirectories = {
	BP_CIRCUIT: "bp-circuit",
	DAILY: "daily",
	SERIES: "series"
};
const delay = (milliseconds) =>
	new Promise((resolve) => setTimeout(resolve, milliseconds));
const numericIdPattern = /^\d+$/;

function sourceTournamentId(row) {
	const value =
		row?.sourceTournamentId ??
		row?.tournamentID ??
		row?.tourIDstr ??
		row?.tournamentId ??
		row?.id ??
		row?.ID;
	if (value === undefined || value === null || value === "") {
		throw new Error("History row has no tournament ID.");
	}
	return String(value);
}

function uniqueRows(rows) {
	const byId = new Map();
	for (const row of rows) {
		byId.set(sourceTournamentId(row), row);
	}
	return [...byId.values()];
}

// Key names and array lengths only (never values), so an empty list can be
// told apart from a response shape the parser does not recognise.
export function describeShape(value, depth = 0) {
	if (Array.isArray(value)) {
		return `[${value.length}]`;
	}
	if (!value || typeof value !== "object") {
		return typeof value;
	}
	if (depth >= 2) {
		return "{…}";
	}
	return `{${Object.entries(value)
		.map(([key, child]) => `${key}:${describeShape(child, depth + 1)}`)
		.join(",")}}`;
}

async function collectPages(post, endpoint, initialBody, shapes) {
	const rows = [];
	let offset = Number(initialBody.offset ?? 0);
	let expected;
	for (let pageNumber = 0; pageNumber < 100; pageNumber++) {
		const payload = await post(endpoint, { ...initialBody, offset });
		if (pageNumber === 0 && shapes) {
			shapes[endpoint] = describeShape(payload).slice(0, 400);
		}
		const page = archivePage(payload);
		if (expected === undefined) {
			expected = page.totalSize;
		}
		if (page.rows.length === 0) {
			break;
		}
		rows.push(...page.rows);
		if (page.totalSize <= rows.length || page.totalSize === 0) {
			break;
		}
		offset += page.rows.length;
	}
	if (expected > 0 && uniqueRows(rows).length !== expected) {
		throw new Error(
			`${endpoint}: fetched only ${uniqueRows(rows).length}/${expected} rows.`
		);
	}
	return uniqueRows(rows);
}

async function collectGroups(post, sourceDealId, categoryID) {
	const numericId = numericIdPattern.test(String(sourceDealId))
		? Number(sourceDealId)
		: 0;
	const rows = [];
	let sourceTotalSize;
	for (let offset = 0; offset < 10_000; offset += 100) {
		const payload = await post(ENDPOINTS.dealGroups, {
			offset,
			nbMaxResult: 100,
			categoryID,
			dealID: numericId,
			dealIDstr: String(sourceDealId),
			groupByContract: true,
			followed: false
		});
		const result = resultDealTournament(payload);
		const pageRows = result.listResultDeal ?? [];
		if (sourceTotalSize === undefined) {
			sourceTotalSize = Number(result.totalSize ?? 0);
		}
		rows.push(...pageRows);
		if (
			sourceTotalSize === 0 ||
			rows.length >= sourceTotalSize ||
			pageRows.length === 0
		) {
			break;
		}
	}
	if (sourceTotalSize > 0 && rows.length !== sourceTotalSize) {
		throw new Error(
			`deal ${sourceDealId}: got ${rows.length}/${sourceTotalSize} contract distribution rows.`
		);
	}
	return {
		listResultDeal: rows,
		totalSize: rows.length,
		sourceTotalSize: sourceTotalSize ?? 0
	};
}

async function collectSummary(post, sourceDealId, categoryID, matchId) {
	const payload = await post(ENDPOINTS.dealSummary, {
		// The web app sends a string deal ID for every category, Daily included.
		dealID: String(sourceDealId),
		categoryID,
		nbMaxMostPlayedContracts: 5,
		...(matchId ? { matchId } : {})
	});
	return dealSummary(payload);
}

async function standardCapture(post, archive, categoryID, options = {}) {
	let seed = options.seed;
	if (!seed && options.fetchSeed) {
		const payload = await post(ENDPOINTS.resultTournament, {
			categoryID,
			tournamentIDstr: sourceTournamentId(archive)
		});
		seed = resultDealTournament(payload);
	}
	const playedRows =
		seed?.listResultDeal?.filter((row) => row.played !== false) ?? [];
	const playedIds = playedRows.length
		? playedRows.map((row) => row.dealIDstr ?? row.dealID)
		: (archive.listPlayedDeals ?? []);
	const capture = {
		archive,
		...(options.parentEvent ? { parentEvent: options.parentEvent } : {}),
		seed,
		boards: [],
		accountId:
			options.accountId ??
			findPlayerId(seed?.tournament?.resultPlayer, ...playedRows),
		family: options.family
	};
	for (const [index, dealId] of playedIds.entries()) {
		options.progress?.(
			`"${archive.title ?? archive.name}" board ${index + 1}/${playedIds.length}`
		);
		const summary = await collectSummary(post, dealId, categoryID);
		capture.accountId ??= findPlayerId(
			summary.result?.tournament?.resultPlayer,
			...(summary.result?.listResultDeal ?? [])
		);
		const groups = await collectGroups(post, dealId, categoryID);
		capture.boards.push({ boardNumber: index + 1, summary, groups });
		await delay(20);
	}
	return capture;
}

async function knockoutCapture(post, archive, options = {}) {
	const matches = knockoutMatches(
		await post(ENDPOINTS.knockoutMatches, {
			tournamentId: sourceTournamentId(archive)
		})
	);
	if (matches.length === 0) {
		throw new Error("No KO match results.");
	}
	const capture = {
		archive,
		kind: "KNOCKOUT",
		matches: [],
		boards: [],
		accountId: options.accountId,
		family: "BP_CIRCUIT"
	};
	let exportBoardNumber = 0;
	for (const matchIndex of matches) {
		if (matchIndex.status === "BYE") {
			capture.matches.push({ match: matchIndex, dealList: [] });
			continue;
		}
		const detail = knockoutMatch(
			await post(ENDPOINTS.knockoutMatch, { matchId: String(matchIndex.id) })
		);
		capture.matches.push(detail);
		capture.accountId ??= findPlayerId(detail.match?.player1, detail.match);
		for (const [index, deal] of detail.dealList.entries()) {
			if (deal.playedPlayer1 === false) {
				continue;
			}
			exportBoardNumber++;
			options.progress?.(
				`"${archive.title ?? archive.name}" round ${detail.match.roundNumber}, board ${index + 1}/${detail.dealList.length}`
			);
			const summary = await collectSummary(
				post,
				deal.dealIDstr,
				45,
				detail.match.id
			);
			capture.boards.push({
				exportBoardNumber,
				boardNumber: index + 1,
				roundNumber: detail.match.roundNumber,
				matchId: detail.match.id,
				sourceDealId: String(deal.dealIDstr),
				summary
			});
			await delay(20);
		}
	}
	return capture;
}

async function collectBpTournament(post, row, options) {
	try {
		return [
			await standardCapture(post, row, 20, { ...options, fetchSeed: true })
		];
	} catch (federalError) {
		if (numericIdPattern.test(sourceTournamentId(row))) {
			try {
				return [await knockoutCapture(post, row, options)];
			} catch {
				/* Continue to BIC detection and report the original route only after all known routes fail. */
			}
		}
		const children = await collectPages(
			post,
			ENDPOINTS.tournamentArchives,
			archiveRequestBody(options.templates, 32, {
				tournamentId: sourceTournamentId(row)
			})
		);
		if (children.length === 0) {
			throw new Error(`Results unavailable: ${federalError.message}`);
		}
		const captures = [];
		for (const child of children) {
			captures.push(
				await standardCapture(post, child, 32, {
					...options,
					fetchSeed: true,
					parentEvent: row
				})
			);
		}
		return captures;
	}
}

// A hand-built getTournamentArchives body may lack fields the Funbridge client
// sends, so start from the request the page actually made when one was
// observed, and only override the paging and category.
export function archiveRequestBody(templates, categoryID, extra = {}) {
	const observed =
		templates?.[`${ENDPOINTS.tournamentArchives}#${categoryID}`]?.body ??
		templates?.[ENDPOINTS.tournamentArchives]?.body ??
		{};
	const { tournamentId: _ignored, ...base } = observed;
	return { count: 50, ...base, ...extra, offset: 0, categoryID };
}

function accountIdFor(captures, provided) {
	if (provided && numericIdPattern.test(provided)) {
		return provided;
	}
	return captures
		.map((capture) => capture.accountId)
		.find((value) => value && numericIdPattern.test(String(value)));
}

async function optionalFamily(family, unavailable, load) {
	try {
		return await load();
	} catch (error) {
		// One history list failing must not throw away the others.
		unavailable.push({
			family,
			reason: error instanceof Error ? error.message : String(error)
		});
		return [];
	}
}

async function collectArchives(post, templates, shapes) {
	// bridgePoints/historic pages with nbMax, not count.
	const historyBody = {
		nbMax: 50,
		offset: 0,
		...(templates[ENDPOINTS.bpHistory]?.body ?? {})
	};
	historyBody.offset = 0;
	const unavailable = [];
	const archives = {
		BP_CIRCUIT: await collectPages(
			post,
			ENDPOINTS.bpHistory,
			historyBody,
			shapes
		),
		SERIES: await optionalFamily("SERIES", unavailable, () =>
			collectPages(
				post,
				ENDPOINTS.tournamentArchives,
				archiveRequestBody(templates, 8)
			)
		),
		DAILY: await optionalFamily("DAILY", unavailable, () =>
			collectPages(
				post,
				ENDPOINTS.tournamentArchives,
				archiveRequestBody(templates, 6)
			)
		)
	};
	return { archives, unavailable };
}

function captureOne(post, family, row, options) {
	if (family === "BP_CIRCUIT") {
		return collectBpTournament(post, row, options);
	}
	const categoryID = family === "SERIES" ? 8 : 6;
	return standardCapture(post, row, categoryID, options).then((capture) => [
		capture
	]);
}

async function captureTournaments(
	post,
	archives,
	{ accountId, onProgress, templates }
) {
	const total = Object.values(archives).reduce(
		(sum, rows) => sum + rows.length,
		0
	);
	const captures = [];
	const skipped = [];
	let completed = 0;
	const progress = (detail) =>
		onProgress?.({ current: completed, total, detail });
	for (const [family, rows] of Object.entries(archives)) {
		for (const row of rows) {
			progress(`Fetching "${row.title ?? row.name}".`);
			try {
				captures.push(
					...(await captureOne(post, family, row, {
						accountId,
						family,
						progress,
						templates
					}))
				);
			} catch (error) {
				skipped.push({
					family,
					sourceTournamentId: sourceTournamentId(row),
					title: row.title ?? row.name,
					reason: error.message
				});
			}
			completed++;
			progress(`Processed ${completed}/${total} tournaments.`);
		}
	}
	return { captures, indexCount: total, skipped };
}

export async function exportAllHistory({
	post,
	templates,
	accountId,
	generator,
	onProgress
}) {
	const capturedAt = new Date().toISOString();
	const shapes = {};
	const { archives, unavailable } = await collectArchives(
		post,
		templates,
		shapes
	);
	const { captures, indexCount, skipped } = await captureTournaments(
		post,
		archives,
		{ accountId, onProgress, templates }
	);

	if (indexCount === 0) {
		const lines = [
			`No tournament could be exported. History rows found: BP Circuit ${archives.BP_CIRCUIT.length}, Series ${archives.SERIES.length}, Daily ${archives.DAILY.length}.`,
			...unavailable.map(
				({ family, reason }) => `${family} history could not be read: ${reason}`
			),
			...(archives.BP_CIRCUIT.length === 0 && shapes[ENDPOINTS.bpHistory]
				? [`BP Circuit response shape: ${shapes[ENDPOINTS.bpHistory]}`]
				: [])
		];
		throw new Error(lines.join("\n"));
	}

	const detectedAccountId = accountIdFor(captures, accountId);
	if (!detectedAccountId && captures.length > 0) {
		throw new Error(
			"Could not detect your Funbridge ID. Enter your numeric ID in the input field and try again."
		);
	}
	for (const capture of captures) {
		capture.accountId = detectedAccountId;
	}

	const files = captures.map((capture) => {
		const built = buildTournamentPbn(
			capture.family,
			capture,
			capturedAt,
			generator ?? "Funbridge History Exporter"
		);
		return {
			path: pbnFileName(familyDirectories[capture.family], built),
			text: built.text
		};
	});
	return {
		files,
		summary: {
			boardCount: captures.reduce(
				(sum, capture) => sum + capture.boards.length,
				0
			),
			indexCount,
			skipped,
			unavailableFamilies: unavailable,
			tournamentFileCount: captures.length
		}
	};
}
