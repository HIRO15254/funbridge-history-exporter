import { SessionStore } from "./lib/capture.js";
import {
	authUrl,
	createDriveClient,
	DriveError,
	tokenFromRedirect
} from "./lib/drive.js";
import { runExport } from "./lib/exporter.js";
import { hintKey } from "./lib/hints.js";
import {
	isSavedTo,
	loadLedger,
	recordSaved,
	saveLedger
} from "./lib/ledger.js";
import {
	badgeFor,
	fractionDone,
	isActive,
	newRun,
	reduceRun,
	runSummary
} from "./lib/progress.js";
import {
	ApiError,
	buildApiRequest,
	isFunbridgePage,
	unwrapApiResult
} from "./lib/protocol.js";
import {
	destinationsFor,
	loadSettings,
	saveLastRun,
	updateSettings
} from "./lib/settings.js";

const chromeApi = globalThis.chrome;
const apiUrls = ["https://*.funbridge.net/funbridge-server-ws/rest/*"];
const funbridgeTabUrls = [
	"https://funbridge.com/*",
	"https://*.funbridge.com/*"
];
const funbridgeHome = "https://play.funbridge.com/";
// chrome.storage.session lives in memory only and is cleared when Chrome
// closes; the Funbridge sign-in is mirrored there so a stopped worker does not
// lose it. chrome.storage.local (on disk) never sees it.
const sessionsKey = "funbridgeSessions";
const runKey = "exportRun";
const notificationId = "funbridge-export";
const signInWaitMs = 30_000;
const resumeWaitMs = 10 * 60_000;

const sessions = new SessionStore();
let run;
let runTabId;
let stopRequested = false;
// The Google token is kept in this worker's memory only.
let driveAuth;

const t = (key, substitutions) =>
	chromeApi.i18n.getMessage(key, substitutions) || key;
const messageOf = (error) =>
	error instanceof Error ? error.message : String(error);

async function keepAliveSleep(milliseconds) {
	await new Promise((resolve) => setTimeout(resolve, milliseconds));
	// Any extension call keeps the worker from being stopped while it waits.
	await chromeApi.runtime.getPlatformInfo().catch(() => {});
}

// --- The signed-in Funbridge session, read from the page's own API calls ---

let sessionSaveTimer;
function scheduleSessionSave() {
	clearTimeout(sessionSaveTimer);
	sessionSaveTimer = setTimeout(() => {
		chromeApi.storage.session
			.set({ [sessionsKey]: sessions.snapshot() })
			.catch(() => {});
	}, 300);
}

// A request made by a service worker of the Funbridge site (if it has one)
// belongs to no tab; it is credited to the Funbridge tab in front.
async function inTab(details) {
	if (details.tabId >= 0) {
		return details;
	}
	if (!isFunbridgePage(details.initiator ?? "")) {
		return undefined;
	}
	const tabs = await funbridgeTabs();
	const tab = tabs?.find((candidate) => candidate.active) ?? tabs?.[0];
	return tab ? { ...details, tabId: tab.id } : undefined;
}

chromeApi.webRequest.onBeforeRequest.addListener(
	(details) => {
		if (details.tabId >= 0) {
			sessions.noteRequest(details);
			return;
		}
		inTab(details).then((attributed) => {
			if (attributed) {
				sessions.noteRequest(attributed);
			}
		});
	},
	{ types: ["xmlhttprequest"], urls: apiUrls },
	["requestBody"]
);

chromeApi.webRequest.onBeforeSendHeaders.addListener(
	(details) => {
		if (details.tabId >= 0) {
			sessions.noteHeaders(details);
			scheduleSessionSave();
			return;
		}
		inTab(details).then((attributed) => {
			if (attributed) {
				sessions.noteHeaders(attributed);
				scheduleSessionSave();
			}
		});
	},
	{ types: ["xmlhttprequest"], urls: apiUrls },
	["requestHeaders", "extraHeaders"]
);

chromeApi.tabs.onRemoved.addListener((tabId) => {
	sessions.forgetTab(tabId);
	scheduleSessionSave();
});

chromeApi.tabs.onUpdated.addListener((tabId, changeInfo) => {
	if (changeInfo.url && !isFunbridgePage(changeInfo.url)) {
		sessions.forgetTab(tabId);
		scheduleSessionSave();
	}
});

// --- Run state: kept in memory, mirrored for the extension pages ---

let runSaveTimer;
function writeRun() {
	clearTimeout(runSaveTimer);
	runSaveTimer = undefined;
	return chromeApi.storage.session.set({ [runKey]: run }).catch(() => {});
}

function persistRun(immediately) {
	if (immediately) {
		return writeRun();
	}
	runSaveTimer ??= setTimeout(writeRun, 250);
	return undefined;
}

let shownBadge = "";
function showBadge() {
	const badge = badgeFor(run);
	const key = `${badge.text}|${badge.color}`;
	if (key === shownBadge) {
		return;
	}
	shownBadge = key;
	chromeApi.action.setBadgeText({ text: badge.text }).catch(() => {});
	chromeApi.action
		.setBadgeBackgroundColor({ color: badge.color })
		.catch(() => {});
	const title = isActive(run)
		? t("badgeTitleRunning", [String(Math.floor(100 * fractionDone(run)))])
		: t("extName");
	chromeApi.action.setTitle({ title }).catch(() => {});
}

const terminalEvents = new Set(["cancelled", "done", "failed", "interrupted"]);

function apply(event) {
	if (!run) {
		return;
	}
	if (event.type === "account") {
		updateSettings(chromeApi.storage.local, {
			detectedAccountId: event.accountId
		}).catch(() => {});
		return;
	}
	run = reduceRun(run, event);
	persistRun(terminalEvents.has(event.type) || event.type === "plan");
	showBadge();
}

// --- Notifications ---

function notify(title, message, buttons) {
	chromeApi.notifications
		.create(notificationId, {
			buttons,
			iconUrl: chromeApi.runtime.getURL("icons/icon-128.png"),
			message,
			priority: 1,
			title,
			type: "basic"
		})
		.catch(() => {
			// Notifications can be off; the badge and progress page still tell.
		});
}

function notifyFinished() {
	const { counts, status } = run;
	if (status === "done") {
		const lines = [
			counts.saved > 0
				? t("notifySaved", [String(counts.saved), String(counts.already)])
				: t("notifyNothingNew", [String(counts.already)])
		];
		if (counts.failed > 0) {
			lines.push(t("notifyFailedSome", [String(counts.failed)]));
		}
		notify(t("notifyDoneTitle"), lines.join(" "));
	} else if (status === "failed" || status === "interrupted") {
		const hint =
			status === "interrupted"
				? t("hintInterrupted")
				: t(hintKey(run.error?.code));
		notify(t("notifyFailedTitle"), `${hint} ${t("savedAreKept")}`);
	}
}

async function finishRun() {
	await writeRun();
	await saveLastRun(chromeApi.storage.local, runSummary(run)).catch(() => {});
	chromeApi.downloads.setUiOptions?.({ enabled: true }).catch(() => {});
	notifyFinished();
}

// --- Extension pages ---

async function openPage(path) {
	const url = chromeApi.runtime.getURL(path);
	try {
		const [existing] = await chromeApi.runtime.getContexts({
			contextTypes: ["TAB"],
			documentUrls: [url]
		});
		if (existing?.tabId >= 0) {
			await chromeApi.tabs.update(existing.tabId, { active: true });
			await chromeApi.windows
				.update(existing.windowId, { focused: true })
				.catch(() => {});
			return;
		}
	} catch {
		// Older Chrome: open a new tab instead.
	}
	await chromeApi.tabs.create({ url });
}

const openProgress = () => openPage("progress.html");

// --- Which tab to use ---

async function funbridgeTabs() {
	try {
		return await chromeApi.tabs.query({ url: funbridgeTabUrls });
	} catch {
		return undefined;
	}
}

function preferredTab(tabs) {
	const signedIn = sessions.ready(
		tabs.find((tab) => tab.active && tab.highlighted)?.id
	);
	const tab =
		(signedIn && tabs.find((candidate) => candidate.id === signedIn.tabId)) ??
		tabs.find((candidate) => candidate.active) ??
		tabs[0];
	return { signedIn: signedIn && tab?.id === signedIn.tabId, tab };
}

async function connectionStatus() {
	const tabs = await funbridgeTabs();
	if (tabs) {
		// Forget sessions of tabs that closed or left Funbridge meanwhile.
		const open = new Set(tabs.map((tab) => tab.id));
		for (const tabId of [...sessions.sessions.keys()]) {
			if (!open.has(tabId)) {
				sessions.forgetTab(tabId);
			}
		}
	}
	if (!tabs?.length) {
		return { state: "no-tab" };
	}
	const { signedIn, tab } = preferredTab(tabs);
	return {
		state: signedIn ? "ready" : "no-sign-in",
		tabId: tab.id,
		title: tab.title ?? ""
	};
}

const cancelledError = () =>
	new ApiError("The export was cancelled.", { code: "CANCELLED" });

// A Funbridge tab where the sign-in was not seen yet is reloaded once: the
// page calls the API while it loads, which shows us the sign-in.
async function signedInTab() {
	const status = await connectionStatus();
	if (status.state === "ready") {
		return status.tabId;
	}
	if (status.state === "no-tab") {
		throw new ApiError("No Funbridge tab is open.", { code: "NO_TAB" });
	}
	apply({ type: "connecting", reloading: true });
	const version = sessions.session(status.tabId).authVersion;
	await chromeApi.tabs.reload(status.tabId);
	const signedIn = await sessions.waitForNewAuthorization(
		status.tabId,
		version,
		{
			sleep: keepAliveSleep,
			stop: () => stopRequested,
			timeoutMs: signInWaitMs
		}
	);
	if (stopRequested) {
		throw cancelledError();
	}
	if (!signedIn) {
		throw new ApiError("No signed-in Funbridge session was seen.", {
			code: "NO_SIGN_IN"
		});
	}
	return status.tabId;
}

// --- Calling the Funbridge API from inside the signed-in tab ---

// Runs in the Funbridge page (serialized by chrome.scripting), so it must not
// use anything from this file.
function pageFetch(url, init) {
	return fetch(url, init).then(
		async (response) => ({
			contentType: response.headers.get("content-type") ?? "",
			redirected: response.redirected,
			status: response.status,
			text: await response.text()
		}),
		(error) => ({
			contentType: "",
			redirected: false,
			status: 0,
			text: String(error?.message ?? error)
		})
	);
}

async function tabStillOnFunbridge(tabId) {
	try {
		return isFunbridgePage((await chromeApi.tabs.get(tabId)).url ?? "");
	} catch {
		return false;
	}
}

async function callInTab(tabId, session, endpoint, body) {
	const request = buildApiRequest(
		session.apiRoot,
		endpoint,
		session.authorization,
		body
	);
	let injection;
	try {
		[injection] = await chromeApi.scripting.executeScript({
			args: [request.url, request.init],
			func: pageFetch,
			target: { tabId },
			world: "MAIN"
		});
	} catch {
		// A page that is reloading cannot run scripts for a moment.
		const code = (await tabStillOnFunbridge(tabId))
			? "TEMPORARY"
			: "TAB_UNAVAILABLE";
		throw new ApiError(`${endpoint}: the Funbridge tab is not available.`, {
			code
		});
	}
	return unwrapApiResult(injection?.result, endpoint);
}

async function waitForSignInAgain(tabId, version) {
	apply({ type: "waiting-sign-in" });
	notify(t("notifySignedOutTitle"), t("notifySignedOutBody"), [
		{ title: t("reloadFunbridge") }
	]);
	const signedIn = await sessions.waitForNewAuthorization(tabId, version, {
		sleep: keepAliveSleep,
		stop: () => stopRequested,
		timeoutMs: resumeWaitMs
	});
	if (stopRequested) {
		throw cancelledError();
	}
	if (!signedIn) {
		throw new ApiError("Funbridge did not sign in again.", {
			code: "AUTH_EXPIRED"
		});
	}
	chromeApi.notifications.clear(notificationId).catch(() => {});
	apply({ type: "signed-in-again" });
}

// A failed call is retried after a pause when it may pass next time, and
// after the user signs in again when the sign-in expired or moved to another
// device (never by signing in on their behalf).
async function recoverOrThrow(error, attempt, tabId, version) {
	if (error.code === "TEMPORARY" && attempt < 3) {
		await keepAliveSleep(1500 * (attempt + 1));
		return;
	}
	if (error.code === "AUTH_EXPIRED" && attempt < 3) {
		await waitForSignInAgain(tabId, version);
		return;
	}
	throw error;
}

function createPoster(tabId) {
	return async (endpoint, body) => {
		for (let attempt = 0; ; attempt++) {
			const session = sessions.sessions.get(tabId);
			if (!session?.authorization) {
				throw new ApiError(`${endpoint}: the Funbridge tab was closed.`, {
					code: "TAB_UNAVAILABLE"
				});
			}
			const version = session.authVersion;
			try {
				return await callInTab(tabId, session, endpoint, body);
			} catch (error) {
				await recoverOrThrow(error, attempt, tabId, version);
			}
		}
	};
}

// --- Saving ---

async function driveToken(clientId, interactive) {
	if (driveAuth?.clientId === clientId && driveAuth.expiresAt > Date.now()) {
		return driveAuth.token;
	}
	const url = authUrl(clientId, chromeApi.identity.getRedirectURL());
	let redirectedTo;
	try {
		// Silent first: after the first consent Google answers without a window.
		redirectedTo = await chromeApi.identity.launchWebAuthFlow({
			interactive: false,
			url
		});
	} catch (silentError) {
		if (!interactive) {
			throw silentError;
		}
		redirectedTo = await chromeApi.identity.launchWebAuthFlow({
			interactive: true,
			url
		});
	}
	const { expiresAt, token } = tokenFromRedirect(redirectedTo);
	driveAuth = { clientId, expiresAt, token };
	return token;
}

function createDriveSaver(clientId) {
	let client;
	const refresh = async () => {
		try {
			client = createDriveClient({ token: await driveToken(clientId, true) });
		} catch (error) {
			throw new ApiError(messageOf(error), { code: "DRIVE_SIGN_IN" });
		}
	};
	return {
		async start() {
			await refresh();
			return client.folderFor(["funbridge-export"]);
		},
		async save(path, text, options) {
			if (!(driveAuth?.expiresAt > Date.now())) {
				await refresh();
			}
			try {
				return await client.save(path, text, options);
			} catch (error) {
				if (!(error instanceof DriveError && error.status === 401)) {
					throw error;
				}
				driveAuth = undefined;
				await refresh();
				return client.save(path, text, options);
			}
		}
	};
}

function pbnDataUrl(text) {
	return `data:application/x-pbn;charset=utf-8,${encodeURIComponent(text)}`;
}

function driveOutcome(results) {
	if (results.some((result) => result === "uploaded")) {
		return "uploaded";
	}
	return results.some((result) => result === "updated") ? "updated" : "exists";
}

async function saveTournament(tournament, { destinations, drive, ledger }) {
	const driveResults = [];
	for (const file of tournament.files) {
		const id = await chromeApi.downloads.download({
			conflictAction: "overwrite",
			filename: file.path,
			saveAs: false,
			url: pbnDataUrl(file.text)
		});
		apply({ id, type: "last-download" });
		if (drive) {
			driveResults.push(
				await drive.save(file.path, file.text, {
					replace: !tournament.complete
				})
			);
		}
	}
	// Recorded right away, so a run that stops later keeps this tournament.
	if (tournament.complete) {
		recordSaved(ledger, tournament.key, {
			destinations,
			paths: tournament.files.map((file) => file.path),
			savedAt: new Date().toISOString()
		});
		await saveLedger(chromeApi.storage.local, ledger);
	}
	return { drive: drive ? driveOutcome(driveResults) : undefined };
}

// --- One export run ---

function generatorLabel() {
	const manifest = chromeApi.runtime.getManifest();
	return `Funbridge History Exporter ${manifest.version}`;
}

async function prepareDrive(settings, destinations) {
	if (!destinations.includes("drive")) {
		return undefined;
	}
	const drive = createDriveSaver(settings.driveClientId);
	apply({ id: await drive.start(), type: "drive-folder" });
	return drive;
}

async function exportFrom(tabId, settings, destinations) {
	const session = sessions.sessions.get(tabId);
	session.exporting = true;
	try {
		const drive = await prepareDrive(settings, destinations);
		const ledger = await loadLedger(chromeApi.storage.local);
		chromeApi.downloads.setUiOptions?.({ enabled: false }).catch(() => {});
		await runExport({
			accountId: settings.accountId,
			generator: generatorLabel(),
			isAlreadyExported: isSavedTo(ledger, destinations),
			knownAccountId: settings.detectedAccountId,
			onEvent: apply,
			post: createPoster(tabId),
			saveTournament: (tournament) =>
				saveTournament(tournament, { destinations, drive, ledger }),
			shouldStop: () => stopRequested,
			templates: session.templates
		});
	} finally {
		session.exporting = false;
	}
}

// Set from the click until the run exists, so a double click starts one run.
let starting = false;

async function startExport() {
	if (starting || isActive(run)) {
		await openProgress();
		return;
	}
	starting = true;
	let settings;
	try {
		settings = await loadSettings(chromeApi.storage.local);
		run = newRun({
			destinations: destinationsFor(settings),
			id: crypto.randomUUID(),
			startedAt: Date.now()
		});
		stopRequested = false;
		runTabId = undefined;
	} finally {
		starting = false;
	}
	await persistRun(true);
	showBadge();
	await openProgress();
	try {
		runTabId = await signedInTab();
		await exportFrom(runTabId, settings, run.destinations);
	} catch (error) {
		if (error?.code === "CANCELLED") {
			apply({ type: "cancelled" });
		} else {
			apply({ code: error?.code, message: messageOf(error), type: "failed" });
		}
	}
	await finishRun();
}

async function reloadFunbridge() {
	const status = await connectionStatus();
	const tabId = runTabId ?? status.tabId;
	if (tabId === undefined) {
		await chromeApi.tabs.create({ url: funbridgeHome });
		return;
	}
	await chromeApi.tabs.reload(tabId);
}

// --- Messages from the extension pages ---

const actions = {
	cancel: () => {
		stopRequested = true;
		return {};
	},
	"connect-drive": async () => {
		const settings = await loadSettings(chromeApi.storage.local);
		if (!settings.driveClientId) {
			throw new Error(t("driveNeedsClientId"));
		}
		driveAuth = undefined;
		await driveToken(settings.driveClientId, true);
		return {};
	},
	export: () => {
		startExport().catch(() => {});
		return {};
	},
	"open-downloads": async () => {
		if (run?.lastDownloadId !== undefined) {
			chromeApi.downloads.show(run.lastDownloadId);
		} else {
			chromeApi.downloads.showDefaultFolder();
		}
		return {};
	},
	"open-funbridge": async () => {
		await chromeApi.tabs.create({ url: funbridgeHome });
		return {};
	},
	"open-progress": async () => {
		await openProgress();
		return {};
	},
	"reload-funbridge": async () => {
		await reloadFunbridge();
		return {};
	},
	status: async () => ({ connection: await connectionStatus() })
};

// Sessions and the run from before this worker started.
const restored = (async () => {
	const stored = await chromeApi.storage.session
		.get([sessionsKey, runKey])
		.catch(() => ({}));
	sessions.restore(stored?.[sessionsKey]);
	run = stored?.[runKey];
	if (isActive(run)) {
		// The worker that ran it was stopped; nothing is running it now.
		apply({ type: "interrupted" });
		await finishRun();
	} else {
		chromeApi.downloads.setUiOptions?.({ enabled: true }).catch(() => {});
	}
	showBadge();
})();

chromeApi.runtime.onMessage.addListener((message, sender, sendResponse) => {
	const action = actions[message?.type];
	if (sender.id !== chromeApi.runtime.id || !action) {
		return false;
	}
	restored
		.then(() => action(message))
		.then(
			(result) => sendResponse({ ok: true, ...result }),
			(error) =>
				sendResponse({ code: error?.code, error: messageOf(error), ok: false })
		);
	return true;
});

chromeApi.notifications.onClicked.addListener((id) => {
	if (id === notificationId) {
		openProgress().catch(() => {});
	}
});

chromeApi.notifications.onButtonClicked.addListener((id) => {
	if (id === notificationId) {
		restored.then(reloadFunbridge).catch(() => {});
	}
});
