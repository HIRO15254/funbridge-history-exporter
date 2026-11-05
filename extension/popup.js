import { fractionDone, isActive } from "./lib/progress.js";
import { destinationsFor, loadLastRun, loadSettings } from "./lib/settings.js";
import {
	exportAction,
	failureHint,
	formatAgo,
	localize,
	send,
	t,
	watchRun
} from "./ui/common.js";
import {
	countLine,
	currentLine,
	statusTitle,
	summaryLine
} from "./ui/run-text.js";

const chromeApi = globalThis.chrome;
const $ = (selector) => document.querySelector(selector);
const view = {
	connection: undefined,
	run: undefined
};

function renderConnection() {
	const { connection } = view;
	const states = {
		"no-sign-in": {
			detail: t("noSignInDetail"),
			dot: "warn",
			title: t("noSignInTitle")
		},
		"no-tab": { detail: t("noTabDetail"), dot: "", title: t("noTabTitle") },
		ready: {
			detail: connection?.title || t("readyDetail"),
			dot: "ready",
			title: t("readyTitle")
		}
	};
	const state = states[connection?.state];
	if (!state) {
		return;
	}
	$("#connection-dot").className = `dot ${state.dot}`;
	$("#connection-title").textContent = state.title;
	$("#connection-detail").textContent = state.detail;
	const action = exportAction(connection);
	const button = $("#main-action");
	button.textContent = action.label;
	button.dataset.action = action.type;
	button.disabled = false;
}

function renderRunning() {
	const { run } = view;
	const active = isActive(run);
	$("#running").hidden = !active;
	$("#connection").hidden = active;
	if (!active) {
		return;
	}
	const waiting = run.status === "waiting-sign-in";
	$("#running-dot").className = `dot ${waiting ? "warn" : "busy"}`;
	$("#running-title").textContent = statusTitle(run);
	$("#running-count").textContent = countLine(run);
	const bar = $("#running-bar");
	const measurable = run.status === "saving" && run.toFetch > 0;
	bar.classList.toggle("indeterminate", !measurable && !waiting);
	bar.firstElementChild.style.width = measurable
		? `${(100 * fractionDone(run)).toFixed(1)}%`
		: "";
	$("#running-detail").textContent = waiting
		? t("waitingSignInShort")
		: currentLine(run);
}

async function renderLastRun() {
	const run = view.run;
	const summary =
		run && !isActive(run)
			? {
					...run.counts,
					finishedAt: run.finishedAt,
					status: run.status,
					errorCode: run.error?.code
				}
			: isActive(run)
				? undefined
				: await loadLastRun(chromeApi.storage.local);
	$("#last-run").hidden = !summary?.finishedAt;
	if (!summary?.finishedAt) {
		return;
	}
	const outcome =
		summary.status === "done"
			? summaryLine(summary)
			: summary.status === "cancelled"
				? t("statusCancelled")
				: failureHint(summary.errorCode);
	$("#last-run-text").textContent =
		`${outcome} — ${formatAgo(summary.finishedAt)}`;
}

async function renderDestinations() {
	const settings = await loadSettings(chromeApi.storage.local);
	const names = destinationsFor(settings).map((destination) =>
		t(destination === "drive" ? "destinationDrive" : "destinationDownloads")
	);
	$("#destinations").textContent = t("savesTo", names.join(" + "));
}

function render() {
	renderConnection();
	renderRunning();
	renderLastRun();
}

async function refreshConnection() {
	try {
		view.connection = (await send("status")).connection;
	} catch (error) {
		$("#connection-title").textContent = t("errorNoWorker");
		$("#connection-detail").textContent = error.message;
	}
	render();
}

$("#main-action").addEventListener("click", async (event) => {
	const button = event.currentTarget;
	button.disabled = true;
	try {
		await send(button.dataset.action);
		window.close();
	} catch (error) {
		$("#connection-detail").textContent = error.message;
		button.disabled = false;
	}
});
$("#settings").addEventListener("click", () => {
	chromeApi.runtime.openOptionsPage();
	window.close();
});
$("#show-progress").addEventListener("click", async () => {
	await send("open-progress").catch(() => {});
	window.close();
});
$("#last-run-details").addEventListener("click", async () => {
	await send("open-progress").catch(() => {});
	window.close();
});
$("#cancel").addEventListener("click", () => {
	send("cancel").catch(() => {});
});

localize();
renderDestinations();
watchRun((run) => {
	view.run = run;
	render();
});
refreshConnection();
// The sign-in can arrive while the popup is open (e.g. after a reload).
setInterval(refreshConnection, 2000);
