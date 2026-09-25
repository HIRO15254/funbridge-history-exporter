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

async function collectPages(post, endpoint, initialBody) {
	const rows = [];
	let offset = Number(initialBody.offset ?? 0);
	let expected;
	for (let pageNumber = 0; pageNumber < 100; pageNumber++) {
		const payload = await post(endpoint, { ...initialBody, offset });
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
		dealID:
			categoryID === 6 && numericIdPattern.test(String(sourceDealId))
				? Number(sourceDealId)
				: String(sourceDealId),
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
		const children = await collectPages(post, ENDPOINTS.tournamentArchives, {
			count: 50,
			offset: 0,
			categoryID: 32,
			tournamentId: sourceTournamentId(row)
		});
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

function accountIdFor(captures, provided) {
	if (provided && numericIdPattern.test(provided)) {
		return provided;
	}
	return captures
		.map((capture) => capture.accountId)
		.find((value) => value && numericIdPattern.test(String(value)));
}

async function collectArchives(post, templates) {
	const historyBody = {
		count: 50,
		offset: 0,
		...(templates[ENDPOINTS.bpHistory]?.body ?? {})
	};
	historyBody.offset = 0;
	return {
		BP_CIRCUIT: await collectPages(post, ENDPOINTS.bpHistory, historyBody),
		SERIES: await collectPages(post, ENDPOINTS.tournamentArchives, {
			count: 50,
			offset: 0,
			categoryID: 8
		}),
		DAILY: await collectPages(post, ENDPOINTS.tournamentArchives, {
			count: 50,
			offset: 0,
			categoryID: 6
		})
	};
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

async function captureTournaments(post, archives, { accountId, onProgress }) {
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
						progress
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
	const archives = await collectArchives(post, templates);
	const { captures, indexCount, skipped } = await captureTournaments(
		post,
		archives,
		{ accountId, onProgress }
	);

	const detectedAccountId = accountIdFor(captures, accountId);
	if (!detectedAccountId) {
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
			tournamentFileCount: captures.length
		}
	};
}
