import { driveFolderUrl } from "./lib/drive.js";
import {
	FAMILIES,
	fractionDone,
	isActive,
	remainingMs
} from "./lib/progress.js";
import { loadLastRun, updateSettings } from "./lib/settings.js";
import {
	element,
	exportAction,
	failureHint,
	familyName,
	formatAgo,
	formatDuration,
	formatNumber,
	formatTime,
	localize,
	send,
	t,
	watchRun
} from "./ui/common.js";
import {
	countLine,
	currentLine,
	statusTitle,
	summaryLine,
	tournamentLabel
} from "./ui/run-text.js";

const chromeApi = globalThis.chrome;
const $ = (selector) => document.querySelector(selector);
const view = {
	connection: undefined,
	filter: "all",
	lastLogKey: "",
	run: undefined
};
const stepOrder = ["connecting", "listing", "saving", "done"];

function stepOf(run) {
	if (run.status === "waiting-sign-in") {
		return "saving";
	}
	if (stepOrder.includes(run.status)) {
		return run.status;
	}
	// A stopped run stops at the step it had reached.
	if (run.fetchStartedAt) {
		return "saving";
	}
	return run.families.BP_CIRCUIT.state === "pending" ? "connecting" : "listing";
}

function renderSteps(run) {
	const current = stepOrder.indexOf(stepOf(run));
	const stopped = !isActive(run) && run.status !== "done";
	for (const item of $("#steps").children) {
		const index = stepOrder.indexOf(item.dataset.step);
		item.className =
			index < current || run.status === "done"
				? "done"
				: index === current
					? stopped
						? "stopped"
						: "current"
					: "";
	}
}

function dotClass(run) {
	if (run.status === "waiting-sign-in") {
		return "warn";
	}
	if (isActive(run)) {
		return "busy";
	}
	return run.status === "done" ? "ready" : "error";
}

function renderMeter(run) {
	const measurable = run.toFetch > 0;
	const fraction = fractionDone(run);
	$("#count").textContent = measurable
		? countLine(run)
		: run.status === "done"
			? formatNumber(0)
			: "—";
	$("#percent").textContent = measurable
		? `${Math.floor(100 * fraction)}%`
		: "";
	const bar = $("#bar");
	const waiting = !measurable && isActive(run);
	bar.classList.toggle("indeterminate", waiting);
	bar.firstElementChild.style.width = waiting
		? ""
		: `${(100 * (run.status === "done" ? 1 : fraction)).toFixed(1)}%`;
	$("#current").textContent =
		run.status === "waiting-sign-in"
			? t("waitingSignInShort")
			: currentLine(run);
}

function renderTiming(run) {
	const now = Date.now();
	const end = run.finishedAt ?? now;
	const parts = [t("elapsed", formatDuration(end - run.startedAt))];
	const left = isActive(run) ? remainingMs(run, now) : undefined;
	if (left !== undefined) {
		parts.push(t("remaining", formatDuration(left)));
	}
	$("#timing").textContent = parts.join(" · ");
}

function actionButton(label, onClick, primary = false) {
	const button = element("button", {
		className: primary ? "primary" : undefined,
		text: label,
		type: "button"
	});
	button.addEventListener("click", onClick);
	return button;
}

const openSettings = () => chromeApi.runtime.openOptionsPage();
const reloadFunbridge = () => send("reload-funbridge").catch(() => {});
const openFunbridge = () => send("open-funbridge").catch(() => {});

// Asks for the Funbridge ID right where the run stopped for the lack of it.
function accountIdForm() {
	const input = element("input", {
		"aria-label": t("accountIdLabel"),
		autocomplete: "off",
		className: "inline-input",
		inputmode: "numeric",
		placeholder: t("accountIdLabel"),
		type: "text"
	});
	const button = actionButton(
		t("saveAndExport"),
		async () => {
			const value = input.value.trim();
			if (!/^\d+$/.test(value)) {
				input.focus();
				return;
			}
			await updateSettings(chromeApi.storage.local, { accountId: value });
			send("export").catch(() => {});
		},
		true
	);
	return element("div", { className: "inline-form" }, [input, button]);
}

function failureActions(code) {
	if (code === "NO_TAB") {
		return [actionButton(t("openFunbridge"), openFunbridge)];
	}
	if (code === "NO_ACCOUNT_ID") {
		return [accountIdForm()];
	}
	if (code === "DRIVE_SIGN_IN") {
		return [actionButton(t("openSettings"), openSettings)];
	}
	if (code === "AUTH_EXPIRED" || code === "NO_SIGN_IN") {
		return [actionButton(t("reloadFunbridge"), reloadFunbridge)];
	}
	return [];
}

function alertFor(run) {
	if (run.status === "waiting-sign-in") {
		return {
			actions: [actionButton(t("reloadFunbridge"), reloadFunbridge, true)],
			body: t("waitingSignInBody"),
			kind: "warn",
			title: t("waitingSignInTitle")
		};
	}
	if (run.status === "failed" || run.status === "interrupted") {
		return {
			actions: failureActions(run.error?.code),
			body: t("savedAreKept"),
			kind: "error",
			raw: run.error?.message,
			title:
				run.status === "interrupted"
					? t("hintInterrupted")
					: failureHint(run.error?.code)
		};
	}
	if (run.status === "cancelled") {
		return {
			body: t("savedAreKept"),
			kind: "info",
			title: t("statusCancelled")
		};
	}
	if (run.status === "done" && run.counts.failed > 0) {
		return {
			body: t("failedRetryNextTime"),
			kind: "info",
			title: t("notifyFailedSome", formatNumber(run.counts.failed))
		};
	}
	if (run.status === "done" && run.toFetch === 0) {
		return {
			body: t("nothingNewBody"),
			kind: "info",
			title: t("nothingNewTitle")
		};
	}
	return undefined;
}

function renderAlert(run) {
	const alert = alertFor(run);
	const box = $("#alert");
	box.hidden = !alert;
	if (!alert) {
		return;
	}
	box.className = `alert ${alert.kind}`;
	$("#alert-title").textContent = alert.title;
	$("#alert-body").textContent = alert.body;
	$("#alert-details").hidden = !alert.raw;
	$("#alert-raw").textContent = alert.raw ?? "";
	$("#alert-actions").replaceChildren(...(alert.actions ?? []));
}

function renderActions(run) {
	const active = isActive(run);
	$("#cancel").hidden = !active;
	const again = $("#again");
	again.hidden = active;
	const action = exportAction(view.connection);
	again.textContent =
		action.type === "export" && view.connection?.state === "ready"
			? t("exportAgain")
			: action.label;
	again.dataset.action = action.type;
	const driveLink = $("#open-drive");
	driveLink.hidden = !run.driveFolderId;
	if (run.driveFolderId) {
		driveLink.href = driveFolderUrl(run.driveFolderId);
	}
}

function renderTiles(run) {
	$("#tile-saved").textContent = formatNumber(run.counts.saved);
	$("#tile-already").textContent = formatNumber(run.counts.already);
	$("#tile-failed").textContent = formatNumber(run.counts.failed);
	$("#tile-failed").classList.toggle("bad", run.counts.failed > 0);
	$("#tile-boards").textContent = formatNumber(run.counts.boards);
}

function familyRow(family, data) {
	const notes = {
		listing: { className: "family-note", text: t("familyListing") },
		pending: { className: "family-note", text: t("familyPending") },
		unavailable: {
			className: "family-note bad",
			text: t("familyUnavailable")
		}
	};
	const note = notes[data.state];
	const cells = [data.found, data.already, data.saved, data.failed].map(
		(value) =>
			element("td", {
				className: "num",
				text: data.state === "listed" ? formatNumber(value) : "—"
			})
	);
	return element("tr", { title: data.reason }, [
		element("td", {}, [
			document.createTextNode(familyName(family)),
			note ? element("span", note) : undefined
		]),
		...cells
	]);
}

function renderFamilies(run) {
	$("#families").replaceChildren(
		...FAMILIES.map((family) => familyRow(family, run.families[family]))
	);
}

const logMarks = {
	failed: { className: "mark failed", text: "✕" },
	"list-failed": { className: "mark warn", text: "!" },
	saved: { className: "mark saved", text: "✓" },
	"sign-in-back": { className: "mark saved", text: "↻" },
	"sign-in-lost": { className: "mark warn", text: "!" }
};

function savedDetail(entry) {
	const parts = [t("boardsCount", formatNumber(entry.boards ?? 0))];
	if (entry.drive === "uploaded" || entry.drive === "updated") {
		parts.push(t("driveUploaded"));
	} else if (entry.drive === "exists") {
		parts.push(t("driveExisting"));
	}
	return parts.join(" · ");
}

function logText(entry) {
	if (entry.kind === "saved") {
		return [
			document.createTextNode(tournamentLabel(entry)),
			element("span", { className: "sub", text: savedDetail(entry) })
		];
	}
	if (entry.kind === "failed" || entry.kind === "list-failed") {
		const label =
			entry.kind === "failed"
				? tournamentLabel(entry)
				: t("familyListFailed", familyName(entry.family));
		return [
			element("details", {}, [
				element("summary", { text: label }),
				element("code", { text: entry.detail ?? "" })
			])
		];
	}
	return [
		document.createTextNode(
			t(entry.kind === "sign-in-lost" ? "logSignInLost" : "logSignInBack")
		)
	];
}

function logItem(entry) {
	return element("li", {}, [
		element("time", { text: formatTime(entry.at) }),
		element("span", logMarks[entry.kind] ?? { className: "mark", text: "·" }),
		element("div", { className: "text" }, logText(entry))
	]);
}

function renderLog(run) {
	const failedCount = run.log.filter((entry) => entry.kind !== "saved").length;
	$("#filter-all").textContent = t("filterAll", formatNumber(run.log.length));
	$("#filter-failed").textContent = t(
		"filterProblems",
		formatNumber(failedCount)
	);
	const key = `${run.id}|${run.log.length}|${run.log.at(-1)?.at}|${view.filter}`;
	if (key === view.lastLogKey) {
		return;
	}
	view.lastLogKey = key;
	const entries = run.log
		.filter((entry) => view.filter === "all" || entry.kind !== "saved")
		.reverse();
	$("#log").replaceChildren(...entries.map(logItem));
	$("#log-empty").hidden = entries.length > 0;
	$("#log-empty").textContent =
		view.filter === "all" ? t("logEmpty") : t("logNoProblems");
}

function renderRun(run) {
	document.title = `${isActive(run) ? `${Math.floor(100 * fractionDone(run))}% · ` : ""}${t("progressTitle")}`;
	$("#status-dot").className = `dot ${dotClass(run)}`;
	$("#status-title").textContent = statusTitle(run);
	$("#started").textContent = t("startedAt", formatTime(run.startedAt));
	renderSteps(run);
	renderMeter(run);
	renderTiming(run);
	renderAlert(run);
	renderActions(run);
	renderTiles(run);
	renderFamilies(run);
	renderLog(run);
}

async function renderEmpty() {
	document.title = t("progressTitle");
	const last = await loadLastRun(chromeApi.storage.local);
	$("#status-dot").className = "dot";
	$("#status-title").textContent = t("noRunTitle");
	$("#started").textContent = last?.finishedAt
		? `${t("lastExport")}: ${summaryLine(last)} — ${formatAgo(last.finishedAt)}`
		: "";
	for (const selector of ["#steps", "#meter", ".tiles", "#alert"]) {
		$(selector).hidden = true;
	}
	for (const section of document.querySelectorAll(".section")) {
		section.hidden = true;
	}
	$("#cancel").hidden = true;
	const again = $("#again");
	const action = exportAction(view.connection);
	again.hidden = false;
	again.textContent = action.label;
	again.dataset.action = action.type;
}

function render() {
	if (view.run) {
		for (const selector of ["#steps", "#meter", ".tiles"]) {
			$(selector).hidden = false;
		}
		for (const section of document.querySelectorAll(".section")) {
			section.hidden = false;
		}
		renderRun(view.run);
	} else {
		renderEmpty();
	}
}

async function refreshConnection() {
	try {
		view.connection = (await send("status")).connection;
	} catch {
		view.connection = undefined;
	}
	render();
}

function setFilter(filter) {
	view.filter = filter;
	$("#filter-all").setAttribute("aria-pressed", String(filter === "all"));
	$("#filter-failed").setAttribute("aria-pressed", String(filter !== "all"));
	render();
}

$("#again").addEventListener("click", (event) => {
	send(event.currentTarget.dataset.action).catch(() => {});
});
$("#cancel").addEventListener("click", () => {
	$("#cancel").disabled = true;
	send("cancel").catch(() => {});
});
$("#open-downloads").addEventListener("click", () => {
	send("open-downloads").catch(() => {});
});
$("#settings").addEventListener("click", openSettings);
$("#filter-all").addEventListener("click", () => setFilter("all"));
$("#filter-failed").addEventListener("click", () => setFilter("problems"));

localize();
watchRun((run) => {
	if (run?.id !== view.run?.id) {
		$("#cancel").disabled = false;
		view.lastLogKey = "";
	}
	view.run = run;
	render();
});
refreshConnection();
setInterval(() => {
	if (view.run && isActive(view.run)) {
		renderTiming(view.run);
	}
}, 1000);
// Keeps the "Export again" button's words right (e.g. after the tab closed).
setInterval(() => {
	if (!(view.run && isActive(view.run))) {
		refreshConnection();
	}
}, 3000);
