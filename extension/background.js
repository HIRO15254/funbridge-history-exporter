import { authUrl, createDriveClient, tokenFromRedirect } from "./lib/drive.js";
import { exportAllHistory } from "./lib/exporter.js";
import {
	clearLedger,
	completedKeys,
	loadLedger,
	saveLedger
} from "./lib/ledger.js";
import {
	authorizationFrom,
	describeObservedCall,
	parseApiUrl,
	parsePostData,
	runtimeFetchExpression,
	unwrapApiResult
} from "./lib/protocol.js";

const protocolVersion = "1.3";
const funbridgePagePattern = /^https:\/\/([^.]+\.)?funbridge\.com\//;
const chromeApi = globalThis.chrome;

let session;
let state = {
	authObserved: false,
	connected: false,
	detail: 'Open a Funbridge tab and click "Detect traffic".',
	phase: "IDLE",
	title: "Not connected"
};

function plural(count, noun) {
	return `${count} ${noun}${count === 1 ? "" : "s"}`;
}

function generatorLabel() {
	const manifest = chromeApi.runtime.getManifest();
	return `${manifest.name} ${manifest.version}`;
}

function publicState() {
	return structuredClone(state);
}

function showBadge(progress, phase) {
	const action = chromeApi.action;
	if (!action) {
		return;
	}
	let text = "";
	let color = "#1f7a4c";
	if (phase === "EXPORTING" && progress?.total) {
		text = `${progress.current}/${progress.total}`;
		if (text.length > 4) {
			text = `${Math.floor((100 * progress.current) / progress.total)}%`;
		}
	} else if (phase === "ERROR") {
		text = "!";
		color = "#c73737";
	}
	action.setBadgeText({ text }).catch(() => {});
	action.setBadgeBackgroundColor({ color }).catch(() => {});
}

function notify(title, message) {
	chromeApi.notifications
		?.create({
			type: "basic",
			iconUrl: chromeApi.runtime.getURL("icons/icon-128.png"),
			title,
			message: message.slice(0, 500),
			priority: 1
		})
		.catch(() => {
			// Notifications can be turned off; the badge and popup still show it.
		});
}

function publish(patch) {
	state = { ...state, ...patch };
	showBadge(state.progress, state.phase);
	chromeApi.runtime
		.sendMessage({ state: publicState(), type: "STATE" })
		.catch(() => {
			// The popup is normally closed while the service worker is exporting.
		});
}

async function activeFunbridgeTab() {
	const [tab] = await chromeApi.tabs.query({
		active: true,
		currentWindow: true
	});
	if (!(tab?.id && funbridgePagePattern.test(tab.url ?? ""))) {
		throw new Error(
			"Open a Funbridge tab where you are signed in, then try again."
		);
	}
	return tab;
}

async function disconnect() {
	const current = session;
	session = undefined;
	if (current) {
		try {
			await chromeApi.debugger.detach(current.debuggee);
		} catch {
			// The tab may already be closed or detached.
		}
	}
	publish({
		authObserved: false,
		connected: false,
		detail: 'Open a Funbridge tab and click "Detect traffic".',
		phase: "IDLE",
		progress: undefined,
		title: "Not connected"
	});
}

async function connect() {
	if (session) {
		return publicState();
	}
	const tab = await activeFunbridgeTab();
	const debuggee = { tabId: tab.id };
	await chromeApi.debugger.attach(debuggee, protocolVersion);
	try {
		await chromeApi.debugger.sendCommand(debuggee, "Network.enable");
		await chromeApi.debugger.sendCommand(debuggee, "Runtime.enable");
	} catch (error) {
		await chromeApi.debugger.detach(debuggee).catch(() => {
			// Preserve the original setup error if Chrome already detached the tab.
		});
		throw error;
	}
	session = {
		debuggee,
		observedCalls: new Set(),
		pendingRequests: new Map(),
		tabId: tab.id,
		templates: {}
	};
	publish({
		authObserved: false,
		connected: true,
		detail:
			"Open your history or a tournament result in Funbridge once. The API authorization is detected and kept in memory only.",
		phase: "MONITORING",
		title: "Waiting for an API request"
	});
	return publicState();
}

function observeAuthorization(current, parsed, headers) {
	const authorization = authorizationFrom(headers);
	if (!authorization) {
		return;
	}
	current.authorization = authorization;
	current.apiRoot = parsed.root;
	publish({
		authObserved: true,
		detail: "Authenticated API detected. You can now export your full history.",
		phase: "READY",
		title: "Ready to export"
	});
}

chromeApi.debugger.onEvent.addListener((source, method, params) => {
	const current = session;
	if (!current || source.tabId !== current.tabId) {
		return;
	}
	if (method === "Network.requestWillBeSent") {
		const observed = describeObservedCall(
			params.request?.url,
			params.request?.postData
		);
		if (observed && current.observedCalls.size < 200) {
			current.observedCalls.add(observed);
		}
		const parsed = parseApiUrl(params.request?.url);
		if (!parsed) {
			return;
		}
		const body = parsePostData(params.request?.postData);
		current.pendingRequests.set(params.requestId, parsed);
		const template = { body, url: params.request.url };
		current.templates[parsed.endpoint] = template;
		if (body.categoryID !== undefined) {
			current.templates[`${parsed.endpoint}#${body.categoryID}`] = template;
		}
		observeAuthorization(current, parsed, params.request?.headers);
		return;
	}
	if (method === "Network.requestWillBeSentExtraInfo") {
		const parsed = current.pendingRequests.get(params.requestId);
		if (parsed) {
			observeAuthorization(current, parsed, params.headers);
		}
	}
});

chromeApi.debugger.onDetach.addListener((source) => {
	if (!session || source.tabId !== session.tabId) {
		return;
	}
	session = undefined;
	publish({
		authObserved: false,
		connected: false,
		detail:
			"The debugger was detached from the tab. Detect traffic again if needed.",
		phase: "IDLE",
		progress: undefined,
		title: "Disconnected"
	});
});

async function apiPost(endpoint, body) {
	const current = session;
	if (!(current?.authorization && current.apiRoot)) {
		throw new Error("No authenticated API has been detected yet.");
	}
	const expression = runtimeFetchExpression(
		current.apiRoot,
		endpoint,
		current.authorization,
		body
	);
	const result = await chromeApi.debugger.sendCommand(
		current.debuggee,
		"Runtime.evaluate",
		{
			awaitPromise: true,
			expression,
			returnByValue: true
		}
	);
	return unwrapApiResult(result, endpoint);
}

async function downloadPbn(path, text) {
	const url = `data:application/x-pbn;charset=utf-8,${encodeURIComponent(text)}`;
	await chromeApi.downloads.download({
		conflictAction: "overwrite",
		filename: path,
		saveAs: false,
		url
	});
}

async function driveClient(clientId) {
	if (!clientId) {
		throw new Error(
			"Enter your Google OAuth client ID in the popup to save to Google Drive."
		);
	}
	const redirectedTo = await chromeApi.identity.launchWebAuthFlow({
		interactive: true,
		url: authUrl(clientId, chromeApi.identity.getRedirectURL())
	});
	// The Drive token lives only in this export run, like the Funbridge one.
	return createDriveClient({ token: tokenFromRedirect(redirectedTo) });
}

// A tournament counts as done only for the destinations it reached, so
// turning Drive on later still uploads what was only downloaded before.
function destinationsOf(entry) {
	return entry?.destinations ?? ["downloads"];
}

function alreadySaved(ledger, destinations) {
	return (key) =>
		Boolean(ledger[key]) &&
		destinations.every((destination) =>
			destinationsOf(ledger[key]).includes(destination)
		);
}

async function saveFiles(files, drive, ledger, destinations) {
	const total = files.length;
	const savedPaths = new Set();
	let driveExisting = 0;
	try {
		for (const [index, file] of files.entries()) {
			await downloadPbn(file.path, file.text);
			if (
				drive &&
				(await drive.saveIfMissing(file.path, file.text)) === "exists"
			) {
				driveExisting++;
			}
			savedPaths.add(file.path);
			publish({
				detail: `Saved ${index + 1}/${total} files.`,
				progress: { current: index + 1, total }
			});
		}
	} finally {
		// Remember what was saved even if a later file failed, so a retry
		// starts where this run stopped.
		const savedAt = new Date().toISOString();
		for (const [key, paths] of completedKeys(files, savedPaths)) {
			const reached = new Set([
				...destinations,
				...(ledger[key] ? destinationsOf(ledger[key]) : [])
			]);
			ledger[key] = { destinations: [...reached], paths, savedAt };
		}
		await saveLedger(chromeApi.storage.local, ledger);
	}
	return { driveExisting };
}

function completionLines(summary, driveReport) {
	const headline = `Saved ${plural(summary.tournamentFileCount, "new tournament")} (${plural(summary.boardCount, "board")}). ${summary.alreadyExported} already saved before.`;
	const lines = [headline];
	if (driveReport) {
		lines.push(driveReport);
	}
	if (summary.skipped.length) {
		lines.push(
			`Skipped ${summary.skipped.length} of ${plural(summary.indexCount, "tournament")} in the history.`
		);
	}
	for (const { family, reason } of summary.unavailableFamilies) {
		lines.push(`${family} history could not be read: ${reason}`);
	}
	for (const row of summary.skipped.slice(0, 3)) {
		lines.push(`Skipped ${row.family} "${row.title}": ${row.reason}`);
	}
	lines.push("Disconnect to discard the credentials.");
	return { headline, detail: lines.join("\n\n") };
}

function reportFailure(current, error) {
	const message = error instanceof Error ? error.message : String(error);
	const observed = [...(current.observedCalls ?? [])];
	publish({
		detail: observed.length
			? `${message}\n\nFunbridge APIs seen in this tab:\n${observed.join("\n")}`
			: message,
		phase: "ERROR",
		progress: undefined,
		title: "Export failed"
	});
	notify("Funbridge export failed", message);
}

async function runExport(
	current,
	{ accountId, driveClientId, reexportAll, toDrive }
) {
	const storageArea = chromeApi.storage.local;
	if (reexportAll) {
		await clearLedger(storageArea);
	}
	const ledger = await loadLedger(storageArea);
	const drive = toDrive ? await driveClient(driveClientId) : undefined;
	const destinations = drive ? ["downloads", "drive"] : ["downloads"];
	const result = await exportAllHistory({
		accountId,
		generator: generatorLabel(),
		isAlreadyExported: alreadySaved(ledger, destinations),
		onProgress(progress) {
			publish({ detail: progress.detail, progress });
		},
		post: apiPost,
		templates: current.templates
	});
	const total = result.files.length;
	publish({
		detail: `Saving ${plural(total, "PBN file")}${drive ? " to Downloads and Google Drive" : ""}.`,
		progress: { current: 0, total }
	});
	const { driveExisting } = await saveFiles(
		result.files,
		drive,
		ledger,
		destinations
	);
	const driveReport = drive
		? `Google Drive: ${total - driveExisting} uploaded, ${driveExisting} already there.`
		: undefined;
	const { headline, detail } = completionLines(result.summary, driveReport);
	publish({
		detail,
		phase: "READY",
		progress: undefined,
		title: "Export complete"
	});
	notify("Funbridge export complete", headline);
}

async function startExport(options) {
	const current = session;
	if (!(current?.authorization && current.apiRoot)) {
		throw new Error("No authenticated API has been detected yet.");
	}
	publish({
		detail: "Fetching BP Circuit, Series, and Daily history.",
		phase: "EXPORTING",
		progress: { current: 0, total: 1 },
		title: "Exporting all history"
	});
	try {
		await runExport(current, options);
	} catch (error) {
		reportFailure(current, error);
	}
}

chromeApi.runtime.onMessage.addListener((message, _sender, sendResponse) => {
	if (message.type === "GET_STATE") {
		sendResponse({ ok: true, state: publicState() });
		return false;
	}
	if (message.type === "EXPORT") {
		if (state.phase === "EXPORTING") {
			sendResponse({
				error: "An export is already running.",
				ok: false,
				state: publicState()
			});
			return false;
		}
		startExport({
			accountId: message.accountId,
			driveClientId: message.driveClientId,
			reexportAll: message.reexportAll === true,
			toDrive: message.toDrive === true
		}).catch((error) => {
			publish({
				detail: error instanceof Error ? error.message : String(error),
				phase: "ERROR",
				title: "Export failed"
			});
		});
		sendResponse({ ok: true, state: publicState() });
		return false;
	}
	const actions = { CONNECT: connect, DISCONNECT: disconnect };
	const action = actions[message.type];
	if (!action) {
		sendResponse({
			error: "Unknown action.",
			ok: false,
			state: publicState()
		});
		return false;
	}
	action()
		.then((nextState) =>
			sendResponse({ ok: true, state: nextState ?? publicState() })
		)
		.catch((error) => {
			publish({
				connected: Boolean(session),
				detail: error instanceof Error ? error.message : String(error),
				phase: "ERROR",
				title: "Action failed"
			});
			sendResponse({ error: state.detail, ok: false, state: publicState() });
		});
	return true;
});
