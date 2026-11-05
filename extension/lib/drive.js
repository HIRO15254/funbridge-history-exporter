// Minimal Google Drive v3 client for the drive.file scope: it only sees and
// writes files and folders this extension created. fetchImpl is injected so
// the tests run without a network.
const apiRoot = "https://www.googleapis.com/drive/v3";
const uploadRoot = "https://www.googleapis.com/upload/drive/v3";
const folderMime = "application/vnd.google-apps.folder";
export const DRIVE_SCOPE = "https://www.googleapis.com/auth/drive.file";

const quote = (value) =>
	`'${String(value).replace(/\\/g, "\\\\").replace(/'/g, "\\'")}'`;

// No prompt=consent: after the first approval Google can answer silently,
// which is what lets the background try a non-interactive sign-in first.
export function authUrl(clientId, redirectUri) {
	const url = new URL("https://accounts.google.com/o/oauth2/v2/auth");
	url.search = new URLSearchParams({
		client_id: clientId,
		redirect_uri: redirectUri,
		response_type: "token",
		scope: DRIVE_SCOPE
	}).toString();
	return url.toString();
}

// The token and when to stop using it (a minute early, so a long upload does
// not start with a token about to expire).
export function tokenFromRedirect(redirectedTo, now = Date.now()) {
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
	const lifetime = Number(params.get("expires_in") ?? 3600);
	return { expiresAt: now + Math.max(0, lifetime - 60) * 1000, token };
}

export class DriveError extends Error {
	constructor(message, status) {
		super(message);
		this.name = "DriveError";
		this.status = status;
	}
}

export function driveFolderUrl(folderId) {
	return `https://drive.google.com/drive/folders/${encodeURIComponent(folderId)}`;
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
			throw new DriveError(`Google Drive: ${reason}`, response.status);
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

	function multipart(metadata, text, mimeType) {
		const boundary = `funbridge-${Math.random().toString(36).slice(2)}`;
		const body = [
			`--${boundary}`,
			"Content-Type: application/json; charset=UTF-8",
			"",
			JSON.stringify(metadata),
			`--${boundary}`,
			`Content-Type: ${mimeType}; charset=UTF-8`,
			"",
			text,
			`--${boundary}--`,
			""
		].join("\r\n");
		return {
			body,
			headers: { "Content-Type": `multipart/related; boundary=${boundary}` }
		};
	}

	// Saves path ("a/b/file.pbn"). A file of that name already in the folder
	// is kept as it is ("exists"), or overwritten when replace is set, for a
	// tournament that was still running last time ("updated").
	async function save(path, text, { replace = false } = {}) {
		const mimeType = "application/x-pbn";
		const parts = path.split("/").filter(Boolean);
		const name = parts.pop();
		const parentId = await folderFor(parts);
		const existing = await findOne(name, parentId);
		if (existing && !replace) {
			return "exists";
		}
		if (existing) {
			await call(
				`${uploadRoot}/files/${encodeURIComponent(existing.id)}?uploadType=media&fields=id`,
				{
					method: "PATCH",
					headers: { "Content-Type": `${mimeType}; charset=UTF-8` },
					body: text
				}
			);
			return "updated";
		}
		const { body, headers } = multipart(
			{ name, parents: [parentId], mimeType },
			text,
			mimeType
		);
		await call(`${uploadRoot}/files?uploadType=multipart&fields=id`, {
			method: "POST",
			headers,
			body
		});
		return "uploaded";
	}

	return { folderFor, save };
}
