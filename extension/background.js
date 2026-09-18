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
	detail: "Funbridgeのタブを開いて「通信を検出」を押してください。",
	phase: "IDLE",
	title: "未接続"
};

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
			"ログイン済みのFunbridgeタブを開いてから実行してください。"
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
		detail: "Funbridgeのタブを開いて「通信を検出」を押してください。",
		phase: "IDLE",
		progress: undefined,
		title: "未接続"
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
			"Funbridge内で履歴や大会結果を1回開いてください。API認証をメモリー内だけで検出します。",
		phase: "MONITORING",
		title: "APIリクエストを待機中"
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
		detail: "認証済みAPIを検出しました。全履歴を取得できます。",
		phase: "READY",
		title: "取得準備完了"
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
			"ブラウザーとの接続が解除されました。必要なら再度検出してください。",
		phase: "IDLE",
		progress: undefined,
		title: "接続解除"
	});
});

async function apiPost(endpoint, body) {
	const current = session;
	if (!(current?.authorization && current.apiRoot)) {
		throw new Error("認証済みAPIが検出されていません。");
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
		throw new Error("認証済みAPIが検出されていません。");
	}
	publish({
		detail: "BP Circuit・Series・Dailyの履歴を取得しています。",
		phase: "EXPORTING",
		progress: { current: 0, total: 1 },
		title: "全履歴を取得中"
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
			detail: `${result.files.length}個のPBNファイルをダウンロードしています。`,
			progress: { current: 0, total: result.files.length }
		});
		for (const [index, file] of result.files.entries()) {
			await downloadPbn(file.path, file.text);
			publish({
				detail: `${index + 1}/${result.files.length}ファイルを保存しました。`,
				progress: { current: index + 1, total: result.files.length }
			});
		}
		publish({
			detail: `${result.summary.tournamentFileCount}大会・${result.summary.boardCount}ボードをPBNで保存しました。履歴索引${result.summary.indexCount}件のうち取得不能: ${result.summary.skipped.length}件。接続解除で認証情報を破棄できます。`,
			phase: "READY",
			progress: undefined,
			title: "取得完了"
		});
	} catch (error) {
		publish({
			detail: error instanceof Error ? error.message : String(error),
			phase: "ERROR",
			progress: undefined,
			title: "取得に失敗しました"
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
				error: "すでに取得中です。",
				ok: false,
				state: publicState()
			});
			return false;
		}
		startExport(message.accountId).catch((error) => {
			publish({
				detail: error instanceof Error ? error.message : String(error),
				phase: "ERROR",
				title: "取得に失敗しました"
			});
		});
		sendResponse({ ok: true, state: publicState() });
		return false;
	}
	const actions = { CONNECT: connect, DISCONNECT: disconnect };
	const action = actions[message.type];
	if (!action) {
		sendResponse({
			error: "不明な操作です。",
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
				title: "操作に失敗しました"
			});
			sendResponse({ error: state.detail, ok: false, state: publicState() });
		});
	return true;
});
