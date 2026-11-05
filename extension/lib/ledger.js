// Remembers which finished tournaments were already saved, so the next export
// fetches and writes only new ones. It stores family:tournamentId keys and the
// file path, never credentials or response bodies.
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

// Several files can come from one history row (a BIC event has one file per
// child tournament), so a key is recorded only once every file of it is saved.
export function completedKeys(files, savedPaths) {
	const byKey = new Map();
	for (const file of files) {
		if (!(file.ledgerKey && file.complete)) {
			continue;
		}
		const entry = byKey.get(file.ledgerKey) ?? { paths: [], allSaved: true };
		entry.paths.push(file.path);
		entry.allSaved &&= savedPaths.has(file.path);
		byKey.set(file.ledgerKey, entry);
	}
	return [...byKey]
		.filter(([, entry]) => entry.allSaved)
		.map(([key, entry]) => [key, entry.paths]);
}
