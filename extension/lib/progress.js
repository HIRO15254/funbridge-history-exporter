// The state of one export run, built only from the events the exporter and the
// background worker report. It is plain data (no credentials, no PBN text), so
// it can be kept in chrome.storage.session and drawn by any extension page.
export const FAMILIES = Object.freeze(["BP_CIRCUIT", "SERIES", "DAILY"]);
export const LOG_LIMIT = 500;

const activeStatuses = new Set([
	"connecting",
	"listing",
	"saving",
	"waiting-sign-in"
]);

export function isActive(run) {
	return activeStatuses.has(run?.status);
}

export function newRun({ id, startedAt, destinations = ["downloads"] }) {
	return {
		counts: {
			already: 0,
			boards: 0,
			driveExisting: 0,
			driveUploaded: 0,
			failed: 0,
			files: 0,
			saved: 0
		},
		current: undefined,
		destinations,
		error: undefined,
		families: Object.fromEntries(
			FAMILIES.map((family) => [
				family,
				{ already: 0, failed: 0, found: 0, saved: 0, state: "pending" }
			])
		),
		fetchStartedAt: undefined,
		finishedAt: undefined,
		id,
		log: [],
		processed: 0,
		startedAt,
		status: "connecting",
		toFetch: 0,
		updatedAt: startedAt
	};
}

// Keeps the newest entries, but never drops a failure while an older
// success can go instead: failures are what the user comes back to read.
function appendLog(log, entry) {
	const next = [...log, entry];
	while (next.length > LOG_LIMIT) {
		const index = next.findIndex((item) => item.kind !== "failed");
		next.splice(index < 0 ? 0 : index, 1);
	}
	return next;
}

function withFamily(run, family, patch) {
	const current = run.families[family];
	if (!current) {
		return run.families;
	}
	return { ...run.families, [family]: { ...current, ...patch(current) } };
}

function about(event) {
	return {
		family: event.family,
		playedAt: event.playedAt,
		title: event.title
	};
}

function finished(run, event, at, status) {
	return {
		...run,
		current: undefined,
		error:
			status === "failed"
				? { code: event.code ?? "ERROR", message: event.message ?? "" }
				: undefined,
		finishedAt: at,
		status
	};
}

const handlers = {
	connecting: (run) => ({ ...run, status: "connecting" }),
	listing: (run, event) => ({
		...run,
		families: withFamily(run, event.family, () => ({ state: "listing" })),
		status: "listing"
	}),
	listed: (run, event) => ({
		...run,
		families: withFamily(run, event.family, () => ({
			found: event.count,
			state: "listed"
		}))
	}),
	"list-failed": (run, event, at) => ({
		...run,
		families: withFamily(run, event.family, () => ({
			reason: event.reason,
			state: "unavailable"
		})),
		log: appendLog(run.log, {
			at,
			detail: event.reason,
			family: event.family,
			kind: "list-failed"
		})
	}),
	plan: (run, event, at) => {
		let families = run.families;
		for (const family of FAMILIES) {
			families = {
				...families,
				[family]: {
					...families[family],
					already: event.already?.[family] ?? 0,
					found: event.found?.[family] ?? families[family].found
				}
			};
		}
		const already = Object.values(event.already ?? {}).reduce(
			(sum, count) => sum + count,
			0
		);
		return {
			...run,
			counts: { ...run.counts, already },
			families,
			fetchStartedAt: at,
			status: "saving",
			toFetch: event.toFetch
		};
	},
	"tournament-start": (run, event, at) => ({
		...run,
		current: { ...about(event), board: 0, boards: undefined, startedAt: at }
	}),
	board: (run, event) =>
		run.current
			? {
					...run,
					current: { ...run.current, board: event.board, boards: event.boards }
				}
			: run,
	"tournament-saved": (run, event, at) => ({
		...run,
		counts: {
			...run.counts,
			boards: run.counts.boards + (event.boards ?? 0),
			driveExisting:
				run.counts.driveExisting + (event.drive === "exists" ? 1 : 0),
			driveUploaded:
				run.counts.driveUploaded +
				(event.drive === "uploaded" || event.drive === "updated" ? 1 : 0),
			files: run.counts.files + (event.files ?? 0),
			saved: run.counts.saved + 1
		},
		current: undefined,
		families: withFamily(run, event.family, (family) => ({
			saved: family.saved + 1
		})),
		log: appendLog(run.log, {
			...about(event),
			at,
			boards: event.boards,
			drive: event.drive,
			kind: "saved"
		}),
		processed: run.processed + 1
	}),
	"tournament-failed": (run, event, at) => ({
		...run,
		counts: { ...run.counts, failed: run.counts.failed + 1 },
		current: undefined,
		families: withFamily(run, event.family, (family) => ({
			failed: family.failed + 1
		})),
		log: appendLog(run.log, {
			...about(event),
			at,
			detail: event.reason,
			kind: "failed"
		}),
		processed: run.processed + 1
	}),
	"waiting-sign-in": (run, _event, at) =>
		run.status === "waiting-sign-in"
			? run
			: {
					...run,
					log: appendLog(run.log, { at, kind: "sign-in-lost" }),
					resumeStatus: run.status,
					status: "waiting-sign-in"
				},
	"signed-in-again": (run, _event, at) =>
		run.status === "waiting-sign-in"
			? {
					...run,
					log: appendLog(run.log, { at, kind: "sign-in-back" }),
					resumeStatus: undefined,
					status: run.resumeStatus ?? "saving"
				}
			: run,
	"last-download": (run, event) => ({ ...run, lastDownloadId: event.id }),
	"drive-folder": (run, event) => ({ ...run, driveFolderId: event.id }),
	done: (run, _event, at) => finished(run, {}, at, "done"),
	cancelled: (run, _event, at) => finished(run, {}, at, "cancelled"),
	failed: (run, event, at) => finished(run, event, at, "failed"),
	interrupted: (run, _event, at) => finished(run, {}, at, "interrupted")
};

export function reduceRun(run, event, at = Date.now()) {
	const handler = handlers[event?.type];
	if (!(run && handler)) {
		return run;
	}
	// A finished run is a record; late events from a stopped worker must not
	// reopen it.
	if (run.finishedAt !== undefined) {
		return run;
	}
	return { ...handler(run, event, at), updatedAt: at };
}

// 0..1, counting the boards of the tournament in progress, so the bar moves
// during a long tournament and never goes backwards.
export function fractionDone(run) {
	if (!run) {
		return 0;
	}
	if (run.status === "done") {
		return 1;
	}
	if (!(run.toFetch > 0)) {
		return 0;
	}
	const partial =
		run.current?.boards > 0
			? Math.min(run.current.board / run.current.boards, 0.99)
			: 0;
	return Math.min((run.processed + partial) / run.toFetch, 1);
}

// Milliseconds left at the pace so far, once there is a pace to go by.
export function remainingMs(run, now = Date.now()) {
	if (
		run?.status !== "saving" ||
		run.fetchStartedAt === undefined ||
		run.processed < 2 ||
		run.processed >= run.toFetch
	) {
		return undefined;
	}
	const perTournament = (now - run.fetchStartedAt) / run.processed;
	return Math.round(perTournament * (run.toFetch - run.processed));
}

export function badgeFor(run) {
	if (run?.status === "waiting-sign-in") {
		return { color: "#b26a00", text: "!" };
	}
	if (run?.status === "failed" || run?.status === "interrupted") {
		return { color: "#c62828", text: "!" };
	}
	if (!isActive(run)) {
		return { color: "#2e7d32", text: "" };
	}
	if (run.status !== "saving" || !(run.toFetch > 0)) {
		return { color: "#1565c0", text: "…" };
	}
	const count = `${run.processed}/${run.toFetch}`;
	return {
		color: "#1565c0",
		text: count.length <= 4 ? count : `${Math.floor(100 * fractionDone(run))}%`
	};
}

// What the popup shows about the previous run after Chrome restarts: counts
// only, no titles or messages.
export function runSummary(run) {
	return {
		already: run.counts.already,
		boards: run.counts.boards,
		errorCode: run.error?.code,
		failed: run.counts.failed,
		finishedAt: run.finishedAt,
		saved: run.counts.saved,
		startedAt: run.startedAt,
		status: run.status
	};
}
