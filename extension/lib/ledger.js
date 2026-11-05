// Remembers which finished tournaments were already saved, so the next export
// fetches and writes only new ones. It stores family:tournamentId keys, file
// paths and where they went, never credentials or response bodies.
const storageKey = "exportedTournaments";

export async function loadLedger(storageArea) {
	try {
		const stored = await storageArea.get(storageKey);
		const entries = stored?.[storageKey];
		return entries && typeof entries === "object" ? { ...entries } : {};
	} catch {
		return {};
	}
}

export async function saveLedger(storageArea, ledger) {
	await storageArea.set({ [storageKey]: ledger });
}

export async function clearLedger(storageArea) {
	await storageArea.remove(storageKey);
}

export async function ledgerSize(storageArea) {
	return Object.keys(await loadLedger(storageArea)).length;
}

// Entries written before destinations were recorded went to Downloads only.
function destinationsOf(entry) {
	return entry?.destinations ?? ["downloads"];
}

// A tournament counts as saved only for the destinations it reached, so
// turning Google Drive on later still uploads what was only downloaded.
export function isSavedTo(ledger, destinations) {
	return (key) =>
		Boolean(ledger[key]) &&
		destinations.every((destination) =>
			destinationsOf(ledger[key]).includes(destination)
		);
}

export function recordSaved(ledger, key, { destinations, paths, savedAt }) {
	const reached = new Set([
		...(ledger[key] ? destinationsOf(ledger[key]) : []),
		...destinations
	]);
	ledger[key] = { destinations: [...reached], paths, savedAt };
	return ledger;
}
