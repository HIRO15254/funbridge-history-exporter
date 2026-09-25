import { exportAllHistory } from "./lib/exporter.js";
import {
	authorizationFrom,
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

function publish(patch) {
	state = { ...state, ...patch };
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
		const parsed = parseApiUrl(params.request?.url);
		if (!parsed) {
			return;
		}
		const body = parsePostData(params.request?.postData);
		current.pendingRequests.set(params.requestId, parsed);
		current.templates[parsed.endpoint] = { body, url: params.request.url };
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

async function startExport(accountId) {
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
		const result = await exportAllHistory({
			accountId,
			generator: generatorLabel(),
			onProgress(progress) {
				publish({ detail: progress.detail, progress });
			},
			post: apiPost,
			templates: current.templates
		});
		publish({
			detail: `Downloading ${plural(result.files.length, "PBN file")}.`,
			progress: { current: 0, total: result.files.length }
		});
		for (const [index, file] of result.files.entries()) {
			await downloadPbn(file.path, file.text);
			publish({
				detail: `Saved ${index + 1}/${result.files.length} files.`,
				progress: { current: index + 1, total: result.files.length }
			});
		}
		publish({
			detail: `Saved ${plural(result.summary.tournamentFileCount, "tournament")} and ${plural(result.summary.boardCount, "board")} as PBN. Skipped ${result.summary.skipped.length} of ${plural(result.summary.indexCount, "tournament")} in the history. Disconnect to discard the credentials.`,
			phase: "READY",
			progress: undefined,
			title: "Export complete"
		});
	} catch (error) {
		publish({
			detail: error instanceof Error ? error.message : String(error),
			phase: "ERROR",
			progress: undefined,
			title: "Export failed"
		});
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
		startExport(message.accountId).catch((error) => {
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
