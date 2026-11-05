// Tracks, per browser tab, the signed-in Funbridge session that the page's own
// API calls reveal. It is fed by chrome.webRequest events, so there is nothing
// to click and no debugger. The background worker mirrors it to
// chrome.storage.session (memory only, never on disk) so that it survives the
// worker being stopped between the page loading and the user exporting.
import {
	apiRootFromUrl,
	authorizationFrom,
	describeObservedCall,
	parseApiUrl,
	parsePostData
} from "./protocol.js";

const maxPendingBodies = 200;
const maxObservedCalls = 200;

export function headersToObject(headers = []) {
	const result = {};
	for (const header of headers) {
		if (header?.name) {
			result[header.name] = header.value ?? "";
		}
	}
	return result;
}

export function decodeRequestBody(requestBody) {
	const bytes = requestBody?.raw?.[0]?.bytes;
	if (!bytes) {
		return undefined;
	}
	try {
		return new TextDecoder().decode(bytes);
	} catch {
		return undefined;
	}
}

export class SessionStore {
	constructor({ now = () => Date.now() } = {}) {
		this.now = now;
		this.sessions = new Map();
		this.pendingBodies = new Map();
		this.listeners = new Set();
	}

	onChange(listener) {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	}

	emit(tabId) {
		for (const listener of this.listeners) {
			listener(tabId);
		}
	}

	session(tabId) {
		let session = this.sessions.get(tabId);
		if (!session) {
			session = {
				tabId,
				authVersion: 0,
				exporting: false,
				observedCalls: new Set(),
				templates: {}
			};
			this.sessions.set(tabId, session);
		}
		return session;
	}

	// webRequest.onBeforeRequest: remember the POST body until the headers
	// arrive, and note the call (names only) for diagnostics.
	noteRequest(details) {
		if (!(details?.tabId >= 0) || !apiRootFromUrl(details.url)) {
			return;
		}
		const session = this.session(details.tabId);
		if (session.exporting) {
			// Our own calls go through the page too; do not learn from them.
			return;
		}
		const body = decodeRequestBody(details.requestBody);
		const observed = describeObservedCall(details.url, body);
		if (observed && session.observedCalls.size < maxObservedCalls) {
			session.observedCalls.add(observed);
		}
		if (body !== undefined && parseApiUrl(details.url)) {
			if (this.pendingBodies.size >= maxPendingBodies) {
				this.pendingBodies.delete(this.pendingBodies.keys().next().value);
			}
			this.pendingBodies.set(details.requestId, body);
		}
	}

	// webRequest.onBeforeSendHeaders: pick up the Authorization header from any
	// Funbridge API call, and keep allowlisted bodies as request templates.
	noteHeaders(details) {
		const root = apiRootFromUrl(details?.url);
		if (!(details?.tabId >= 0) || !root) {
			return;
		}
		const session = this.session(details.tabId);
		const body = this.pendingBodies.get(details.requestId);
		this.pendingBodies.delete(details.requestId);
		const authorization = authorizationFrom(
			headersToObject(details.requestHeaders)
		);
		if (!authorization) {
			return;
		}
		const changed =
			authorization !== session.authorization || root !== session.apiRoot;
		session.authorization = authorization;
		session.apiRoot = root;
		session.authorizedAt = this.now();
		if (changed) {
			session.authVersion++;
		}
		const parsed = parseApiUrl(details.url);
		if (parsed && body !== undefined && !session.exporting) {
			const template = { body: parsePostData(body), url: details.url };
			session.templates[parsed.endpoint] = template;
			if (template.body.categoryID !== undefined) {
				session.templates[`${parsed.endpoint}#${template.body.categoryID}`] =
					template;
			}
		}
		if (changed) {
			this.emit(details.tabId);
		}
	}

	// Plain data for chrome.storage.session. Request bodies waiting for their
	// headers and the exporting flag are per-worker and are not kept.
	snapshot() {
		return [...this.sessions.values()]
			.filter((session) => session.authorization)
			.map((session) => ({
				apiRoot: session.apiRoot,
				authVersion: session.authVersion,
				authorization: session.authorization,
				authorizedAt: session.authorizedAt,
				observedCalls: [...session.observedCalls],
				tabId: session.tabId,
				templates: session.templates
			}));
	}

	// Sessions seen since this worker started are newer than the snapshot, so
	// the snapshot only fills in tabs this worker has not heard from yet.
	restore(snapshot) {
		if (!Array.isArray(snapshot)) {
			return;
		}
		for (const saved of snapshot) {
			if (!(saved?.tabId >= 0 && saved.authorization)) {
				continue;
			}
			if (this.sessions.get(saved.tabId)?.authorization) {
				continue;
			}
			const session = this.session(saved.tabId);
			Object.assign(session, {
				apiRoot: saved.apiRoot,
				authVersion: saved.authVersion ?? 0,
				authorization: saved.authorization,
				authorizedAt: saved.authorizedAt ?? 0,
				observedCalls: new Set(saved.observedCalls ?? []),
				templates: saved.templates ?? {}
			});
			this.emit(saved.tabId);
		}
	}

	forgetTab(tabId) {
		if (this.sessions.delete(tabId)) {
			this.emit(tabId);
		}
	}

	// A tab with a usable session: the preferred one if it has one, otherwise
	// the most recently authorized tab.
	ready(preferredTabId) {
		const preferred = this.sessions.get(preferredTabId);
		if (preferred?.authorization) {
			return preferred;
		}
		let best;
		for (const session of this.sessions.values()) {
			if (
				session.authorization &&
				(!best || session.authorizedAt > best.authorizedAt)
			) {
				best = session;
			}
		}
		return best;
	}

	// Resolves true once the tab presents a different Authorization header than
	// the one at authVersion (pass -1 for "any"), e.g. after the page reloaded
	// and signed in again. Resolves false on timeout, or when stop() says so.
	async waitForNewAuthorization(
		tabId,
		authVersion,
		{ timeoutMs, sleep, stop }
	) {
		const pause = sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
		const deadline = this.now() + timeoutMs;
		while (this.now() < deadline && !stop?.()) {
			const session = this.sessions.get(tabId);
			if (session?.authorization && session.authVersion !== authVersion) {
				return true;
			}
			await pause(500);
		}
		return false;
	}
}
