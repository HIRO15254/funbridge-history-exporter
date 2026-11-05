// User settings and the previous run's counts, in chrome.storage.local. The
// Google client ID is not a secret, and the Funbridge ID is the public player
// number shown in the app. No sign-in data is ever stored here.
const settingsKey = "settings";
const lastRunKey = "lastRun";

export const defaultSettings = Object.freeze({
	// Typed by the user; wins over detection.
	accountId: "",
	// Learned from results during an export.
	detectedAccountId: "",
	driveClientId: "",
	toDrive: false
});

export async function loadSettings(storageArea) {
	try {
		const stored = (await storageArea.get(settingsKey))?.[settingsKey];
		return { ...defaultSettings, ...(stored ?? {}) };
	} catch {
		return { ...defaultSettings };
	}
}

export async function updateSettings(storageArea, patch) {
	const next = { ...(await loadSettings(storageArea)), ...patch };
	await storageArea.set({ [settingsKey]: next });
	return next;
}

export async function loadLastRun(storageArea) {
	try {
		return (await storageArea.get(lastRunKey))?.[lastRunKey];
	} catch {
		return undefined;
	}
}

export async function saveLastRun(storageArea, summary) {
	await storageArea.set({ [lastRunKey]: summary });
}

export function destinationsFor(settings) {
	return settings.toDrive && settings.driveClientId
		? ["downloads", "drive"]
		: ["downloads"];
}
