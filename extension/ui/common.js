// Shared by the popup, the progress page and the settings page.
import { hintKey } from "../lib/hints.js";

const chromeApi = globalThis.chrome;
const runKey = "exportRun";

export const language = chromeApi.i18n.getUILanguage();

export function t(key, substitutions) {
	const values =
		substitutions === undefined
			? undefined
			: [].concat(substitutions).map((value) => String(value));
	return chromeApi.i18n.getMessage(key, values) || key;
}

// Fills every data-i18n* attribute with the message of that name.
export function localize(root = document) {
	document.documentElement.lang = language;
	for (const element of root.querySelectorAll("[data-i18n]")) {
		element.textContent = t(element.dataset.i18n);
	}
	for (const element of root.querySelectorAll("[data-i18n-placeholder]")) {
		element.placeholder = t(element.dataset.i18nPlaceholder);
	}
	for (const element of root.querySelectorAll("[data-i18n-label]")) {
		const label = t(element.dataset.i18nLabel);
		element.title = label;
		element.setAttribute("aria-label", label);
	}
}

export function familyName(family) {
	return t(`family_${family}`);
}

export function formatNumber(value) {
	return new Intl.NumberFormat(language).format(value ?? 0);
}

export function formatDate(timestamp) {
	return timestamp
		? new Intl.DateTimeFormat(language, { dateStyle: "medium" }).format(
				new Date(timestamp)
			)
		: "";
}

export function formatTime(timestamp) {
	return new Intl.DateTimeFormat(language, { timeStyle: "short" }).format(
		new Date(timestamp)
	);
}

export function formatDuration(milliseconds) {
	const seconds = Math.max(0, Math.round(milliseconds / 1000));
	if (seconds < 60) {
		return new Intl.NumberFormat(language, {
			style: "unit",
			unit: "second",
			unitDisplay: "long"
		}).format(seconds);
	}
	const minutes = Math.round(seconds / 60);
	if (minutes < 120) {
		return new Intl.NumberFormat(language, {
			style: "unit",
			unit: "minute",
			unitDisplay: "long"
		}).format(minutes);
	}
	return new Intl.NumberFormat(language, {
		maximumFractionDigits: 1,
		style: "unit",
		unit: "hour",
		unitDisplay: "long"
	}).format(minutes / 60);
}

export function formatAgo(timestamp, now = Date.now()) {
	const format = new Intl.RelativeTimeFormat(language, { numeric: "auto" });
	const seconds = Math.round((timestamp - now) / 1000);
	if (Math.abs(seconds) < 60) {
		return format.format(0, "minute");
	}
	const minutes = Math.round(seconds / 60);
	if (Math.abs(minutes) < 60) {
		return format.format(minutes, "minute");
	}
	const hours = Math.round(minutes / 60);
	if (Math.abs(hours) < 24) {
		return format.format(hours, "hour");
	}
	return format.format(Math.round(hours / 24), "day");
}

export async function send(type, extra = {}) {
	const response = await chromeApi.runtime.sendMessage({ type, ...extra });
	if (!response?.ok) {
		const error = new Error(response?.error || t("errorNoWorker"));
		error.code = response?.code;
		throw error;
	}
	return response;
}

// Calls back with the current run (or undefined) now and on every change.
export function watchRun(callback) {
	chromeApi.storage.session
		.get(runKey)
		.then((stored) => callback(stored?.[runKey]))
		.catch(() => callback(undefined));
	chromeApi.storage.onChanged.addListener((changes, area) => {
		if (area === "session" && changes[runKey]) {
			callback(changes[runKey].newValue);
		}
	});
}

// The main button's words depend on what clicking it will do.
export function exportAction(connection) {
	if (connection?.state === "no-tab") {
		return { label: t("openFunbridge"), type: "open-funbridge" };
	}
	if (connection?.state === "no-sign-in") {
		return { label: t("reloadAndExport"), type: "export" };
	}
	return { label: t("exportNew"), type: "export" };
}

// A short line on why a run stopped and what to do about it.
export function failureHint(code) {
	return t(hintKey(code));
}

export function element(tag, attributes = {}, children = []) {
	const node = document.createElement(tag);
	for (const [name, value] of Object.entries(attributes)) {
		if (value === undefined || value === false) {
			continue;
		}
		if (name === "text") {
			node.textContent = value;
		} else if (name === "className") {
			node.className = value;
		} else {
			node.setAttribute(name, value === true ? "" : value);
		}
	}
	node.append(...children.filter(Boolean));
	return node;
}
