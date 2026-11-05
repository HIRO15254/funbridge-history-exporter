// Minimal Google Drive v3 client for the drive.file scope: it only sees and
// writes files and folders this extension created. fetchImpl is injected so
// the tests run without a network.
const apiRoot = "https://www.googleapis.com/drive/v3";
const uploadRoot = "https://www.googleapis.com/upload/drive/v3";
const folderMime = "application/vnd.google-apps.folder";
export const DRIVE_SCOPE = "https://www.googleapis.com/auth/drive.file";

const quote = (value) =>
	`'${String(value).replace(/\\/g, "\\\\").replace(/'/g, "\\'")}'`;

export function authUrl(clientId, redirectUri) {
	const url = new URL("https://accounts.google.com/o/oauth2/v2/auth");
	url.search = new URLSearchParams({
		client_id: clientId,
		redirect_uri: redirectUri,
		response_type: "token",
		scope: DRIVE_SCOPE,
		prompt: "consent"
	}).toString();
	return url.toString();
}

export function tokenFromRedirect(redirectedTo) {
	const fragment = new URL(redirectedTo).hash.replace(/^#/, "");
	const params = new URLSearchParams(fragment);
	const error = params.get("error");
	if (error) {
		throw new Error(`Google sign-in failed: ${error}`);
	}
	const token = params.get("access_token");
	if (!token) {
		throw new Error("Google sign-in returned no access token.");
	}
	return token;
}

export function createDriveClient({ token, fetchImpl = fetch }) {
	async function call(url, options = {}) {
		const response = await fetchImpl(url, {
			...options,
			headers: { Authorization: `Bearer ${token}`, ...(options.headers ?? {}) }
		});
		const text = await response.text();
		if (!response.ok) {
			let reason = `HTTP ${response.status}`;
			try {
				reason = JSON.parse(text)?.error?.message ?? reason;
			} catch {
				/* keep the status */
			}
			throw new Error(`Google Drive: ${reason}`);
		}
		return text ? JSON.parse(text) : {};
	}

	async function findOne(name, parentId, mimeType) {
		const conditions = [
			`name = ${quote(name)}`,
			`${quote(parentId)} in parents`,
			"trashed = false"
		];
		if (mimeType) {
			conditions.push(`mimeType = ${quote(mimeType)}`);
		}
		const url = new URL(`${apiRoot}/files`);
		url.search = new URLSearchParams({
			q: conditions.join(" and "),
			fields: "files(id,name)",
			spaces: "drive",
			pageSize: "1"
		}).toString();
		const result = await call(url.toString());
		return result.files?.[0];
	}

	const folderCache = new Map();
	async function ensureFolder(name, parentId) {
		const cacheKey = `${parentId}/${name}`;
		if (!folderCache.has(cacheKey)) {
			folderCache.set(
				cacheKey,
				(async () => {
					const existing = await findOne(name, parentId, folderMime);
					if (existing) {
						return existing.id;
					}
					const created = await call(`${apiRoot}/files?fields=id`, {
						method: "POST",
						headers: { "Content-Type": "application/json" },
						body: JSON.stringify({
							name,
							mimeType: folderMime,
							parents: [parentId]
						})
					});
					return created.id;
				})()
			);
		}
		return folderCache.get(cacheKey);
	}

	async function folderFor(directories) {
		let parentId = "root";
		for (const directory of directories) {
			parentId = await ensureFolder(directory, parentId);
		}
		return parentId;
	}

	// Saves path ("a/b/file.pbn") unless a file of that name is already in the
	// folder. Returns "uploaded" or "exists".
	async function saveIfMissing(path, text, mimeType = "application/x-pbn") {
		const parts = path.split("/").filter(Boolean);
		const name = parts.pop();
		const parentId = await folderFor(parts);
		if (await findOne(name, parentId)) {
			return "exists";
		}
		const boundary = `funbridge-${Math.random().toString(36).slice(2)}`;
		const body = [
			`--${boundary}`,
			"Content-Type: application/json; charset=UTF-8",
			"",
			JSON.stringify({ name, parents: [parentId], mimeType }),
			`--${boundary}`,
			`Content-Type: ${mimeType}; charset=UTF-8`,
			"",
			text,
			`--${boundary}--`,
			""
		].join("\r\n");
		await call(`${uploadRoot}/files?uploadType=multipart&fields=id`, {
			method: "POST",
			headers: { "Content-Type": `multipart/related; boundary=${boundary}` },
			body
		});
		return "uploaded";
	}

	return { saveIfMissing };
}
