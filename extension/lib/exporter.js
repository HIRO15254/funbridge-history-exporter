import { buildTournamentPbn, pbnFileName } from "./pbn.js";
import { FAMILIES } from "./progress.js";
import {
	ApiError,
	archivePage,
	dealSummary,
	ENDPOINTS,
	findPlayerId,
	knockoutMatch,
	knockoutMatches,
	resultDealTournament,
	tournamentIdOf
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
	const value = tournamentIdOf(row);
	if (value === undefined) {
		throw new Error("History row has no tournament ID.");
	}
	return value;
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
		options.onBoard?.(index + 1, playedIds.length);
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
			options.onBoard?.(exportBoardNumber);
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

async function tryKnockout(post, row, options) {
	if (!numericIdPattern.test(sourceTournamentId(row))) {
		return undefined;
	}
	try {
		return [await knockoutCapture(post, row, options)];
	} catch (error) {
		if (isFatal(error)) {
			throw error;
		}
		// Continue to BIC detection; the original error is reported only after
		// every known route fails.
		return undefined;
	}
}

async function collectBicChildren(post, row, options, federalError) {
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

async function collectBpTournament(post, row, options) {
	try {
		return [
			await standardCapture(post, row, 20, { ...options, fetchSeed: true })
		];
	} catch (federalError) {
		if (isFatal(federalError)) {
			throw federalError;
		}
		return (
			(await tryKnockout(post, row, options)) ??
			(await collectBicChildren(post, row, options, federalError))
		);
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

export { FAMILIES };

// Errors that stop the whole run instead of failing one tournament: nothing
// later can succeed (or the user asked to stop) until something changes.
const fatalCodes = new Set([
	"AUTH_EXPIRED",
	"CANCELLED",
	"NO_ACCOUNT_ID",
	"SAVE_FAILED",
	"TAB_UNAVAILABLE"
]);

export function isFatal(error) {
	return fatalCodes.has(error?.code);
}

const messageOf = (error) =>
	error instanceof Error ? error.message : String(error);

export function ledgerKey(family, row) {
	return `${family}:${sourceTournamentId(row)}`;
}

// A tournament still running can gain boards and results, so only a finished
// one is remembered as exported and skipped on the next run.
export function isFinished(row) {
	return (
		row?.finished !== false &&
		row?.inProgress !== true &&
		row?.liveTournament !== true
	);
}

function playedAtOf(row) {
	const value = row?.startDate ?? row?.date ?? row?.beginDate ?? row?.endDate;
	return Number.isFinite(Number(value)) && Number(value) > 0
		? Number(value)
		: undefined;
}

function entryFor(family, row) {
	return {
		complete: isFinished(row),
		family,
		key: ledgerKey(family, row),
		playedAt: playedAtOf(row),
		row,
		title: String(row.title ?? row.name ?? sourceTournamentId(row))
	};
}

function listFamily(post, family, templates, shapes) {
	if (family === "BP_CIRCUIT") {
		// bridgePoints/historic pages with nbMax, not count.
		const body = {
			nbMax: 50,
			...(templates?.[ENDPOINTS.bpHistory]?.body ?? {}),
			offset: 0
		};
		return collectPages(post, ENDPOINTS.bpHistory, body, shapes);
	}
	return collectPages(
		post,
		ENDPOINTS.tournamentArchives,
		archiveRequestBody(templates, family === "SERIES" ? 8 : 6)
	);
}

// Reads the three history lists. One list failing must not throw away the
// others, unless the failure means no request can succeed.
export async function listHistory({ post, templates, onEvent }) {
	const shapes = {};
	const entries = [];
	const unavailable = [];
	for (const family of FAMILIES) {
		onEvent?.({ type: "listing", family });
		try {
			const rows = await listFamily(post, family, templates, shapes);
			entries.push(...rows.map((row) => entryFor(family, row)));
			onEvent?.({ type: "listed", family, count: rows.length });
		} catch (error) {
			if (isFatal(error)) {
				throw error;
			}
			unavailable.push({ family, reason: messageOf(error) });
			onEvent?.({ type: "list-failed", family, reason: messageOf(error) });
		}
	}
	return { entries, shapes, unavailable };
}

function noHistoryError(unavailable, shapes) {
	const lines = [
		"No tournament was found in your Funbridge history.",
		...unavailable.map(
			({ family, reason }) => `${family} history could not be read: ${reason}`
		),
		...(shapes[ENDPOINTS.bpHistory]
			? [`BP Circuit response shape: ${shapes[ENDPOINTS.bpHistory]}`]
			: [])
	];
	return new ApiError(lines.join("\n"), { code: "NO_HISTORY" });
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

const validId = (value) =>
	value !== undefined && value !== null && numericIdPattern.test(String(value))
		? String(value)
		: undefined;

function countByFamily(entries) {
	const counts = Object.fromEntries(FAMILIES.map((family) => [family, 0]));
	for (const entry of entries) {
		counts[entry.family]++;
	}
	return counts;
}

// The player's own Funbridge ID decides which seat is "you" in the PBN. A
// configured ID wins; otherwise each tournament's results name it, and the
// last one seen covers tournaments whose results do not.
class AccountResolver {
	constructor({ accountId, knownAccountId, emit }) {
		this.configured = validId(accountId);
		this.known = validId(knownAccountId);
		this.emit = emit;
	}

	resolve(captures) {
		if (this.configured) {
			return this.configured;
		}
		const detected = captures
			.map((capture) => validId(capture.accountId))
			.find(Boolean);
		if (detected && detected !== this.known) {
			this.known = detected;
			this.emit({ type: "account", accountId: detected });
		}
		if (!this.known) {
			throw new ApiError(
				"Your Funbridge ID could not be detected. Enter it in the extension settings, then export again.",
				{ code: "NO_ACCOUNT_ID" }
			);
		}
		return this.known;
	}
}

function buildFiles(entry, captures, accountId, { capturedAt, generator }) {
	return captures.map((capture) => {
		capture.accountId = accountId;
		const built = buildTournamentPbn(
			entry.family,
			capture,
			capturedAt,
			generator ?? "Funbridge History Exporter"
		);
		return {
			boards: capture.boards.length,
			path: pbnFileName(familyDirectories[entry.family], built),
			text: built.text
		};
	});
}

async function saveOrStop(saveTournament, tournament) {
	try {
		return (await saveTournament(tournament)) ?? {};
	} catch (error) {
		if (isFatal(error)) {
			throw error;
		}
		throw new ApiError(`Could not save the PBN file: ${messageOf(error)}`, {
			code: "SAVE_FAILED"
		});
	}
}

async function exportEntry(entry, context) {
	const { emit, post, templates } = context;
	const captures = await captureOne(post, entry.family, entry.row, {
		family: entry.family,
		onBoard: (board, boards) => emit({ type: "board", board, boards }),
		templates
	});
	const accountId = context.accounts.resolve(captures);
	const files = buildFiles(entry, captures, accountId, context);
	const saved = await saveOrStop(context.saveTournament, {
		complete: entry.complete,
		family: entry.family,
		files,
		key: entry.key
	});
	return {
		boards: files.reduce((sum, file) => sum + file.boards, 0),
		drive: saved.drive,
		files: files.length
	};
}

const cancelled = () =>
	new ApiError("The export was cancelled.", { code: "CANCELLED" });

async function exportEntries(todo, context) {
	const { emit, shouldStop } = context;
	const outcome = { failed: 0, saved: 0 };
	for (const [index, entry] of todo.entries()) {
		if (shouldStop?.()) {
			throw cancelled();
		}
		const about = {
			family: entry.family,
			key: entry.key,
			playedAt: entry.playedAt,
			title: entry.title
		};
		emit({ type: "tournament-start", index, ...about });
		try {
			const result = await exportEntry(entry, context);
			outcome.saved++;
			emit({ type: "tournament-saved", ...about, ...result });
		} catch (error) {
			if (isFatal(error)) {
				throw error;
			}
			outcome.failed++;
			emit({ type: "tournament-failed", ...about, reason: messageOf(error) });
		}
	}
	return outcome;
}

// One export run: list the history, skip what was saved before, then fetch
// and save one tournament at a time so progress is real and an interrupted
// run keeps everything it already saved. Every step is reported through
// onEvent; a fatal error (sign-in lost, tab closed, save failed) is thrown.
export async function runExport({
	post,
	templates = {},
	accountId,
	knownAccountId,
	generator,
	isAlreadyExported,
	saveTournament,
	onEvent,
	shouldStop,
	now = Date.now
}) {
	const emit = (event) => onEvent?.(event);
	const guardedPost = (endpoint, body) => {
		if (shouldStop?.()) {
			throw cancelled();
		}
		return post(endpoint, body);
	};
	try {
		const { entries, shapes, unavailable } = await listHistory({
			onEvent: emit,
			post: guardedPost,
			templates
		});
		if (entries.length === 0) {
			throw noHistoryError(unavailable, shapes);
		}
		const already = entries.filter(
			(entry) => entry.complete && isAlreadyExported?.(entry.key)
		);
		const todo = entries.filter((entry) => !already.includes(entry));
		emit({
			type: "plan",
			already: countByFamily(already),
			found: countByFamily(entries),
			toFetch: todo.length
		});
		const outcome = await exportEntries(todo, {
			accounts: new AccountResolver({ accountId, emit, knownAccountId }),
			capturedAt: new Date(now()).toISOString(),
			emit,
			generator,
			post: guardedPost,
			saveTournament,
			shouldStop,
			templates
		});
		emit({ type: "done" });
		return { already: already.length, found: entries.length, ...outcome };
	} catch (error) {
		if (error?.code === "CANCELLED") {
			emit({ type: "cancelled" });
			return { cancelled: true };
		}
		throw error;
	}
}
