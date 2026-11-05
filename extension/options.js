import { clearLedger, ledgerSize } from "./lib/ledger.js";
import { isActive } from "./lib/progress.js";
import { loadSettings, updateSettings } from "./lib/settings.js";
import { formatNumber, localize, send, t, watchRun } from "./ui/common.js";

const chromeApi = globalThis.chrome;
const storage = chromeApi.storage.local;
const $ = (selector) => document.querySelector(selector);
let running = false;
let flashTimer;

function flash(text) {
	$("#saved-flash").textContent = text;
	clearTimeout(flashTimer);
	flashTimer = setTimeout(() => {
		$("#saved-flash").textContent = "";
	}, 1800);
}

async function save(patch) {
	await updateSettings(storage, patch);
	flash(t("settingsSaved"));
}

function renderDrive() {
	$("#drive-setup").hidden = !$("#to-drive").checked;
	$("#connect-drive").disabled = !$("#drive-client-id").value.trim();
}

async function renderLedger() {
	const count = await ledgerSize(storage);
	$("#ledger-count").textContent = t("ledgerCount", formatNumber(count));
	$("#forget").disabled = count === 0 || running;
}

function renderAccountHelp(settings) {
	$("#account-help").textContent = settings.detectedAccountId
		? t("accountDetected", settings.detectedAccountId)
		: t("accountHelp");
	$("#account-id").placeholder = settings.detectedAccountId || "1234567";
}

async function load() {
	const settings = await loadSettings(storage);
	$("#to-drive").checked = settings.toDrive;
	$("#drive-client-id").value = settings.driveClientId;
	$("#account-id").value = settings.accountId;
	$("#redirect-uri").textContent = chromeApi.identity.getRedirectURL();
	$("#advanced").open = Boolean(settings.accountId);
	renderAccountHelp(settings);
	renderDrive();
	await renderLedger();
}

$("#to-drive").addEventListener("change", () => {
	renderDrive();
	save({ toDrive: $("#to-drive").checked });
});

$("#drive-client-id").addEventListener("input", renderDrive);
$("#drive-client-id").addEventListener("change", () => {
	$("#drive-status").textContent = "";
	save({ driveClientId: $("#drive-client-id").value.trim() });
});

$("#account-id").addEventListener("change", () => {
	const value = $("#account-id").value.trim();
	if (value && !/^\d+$/.test(value)) {
		flash(t("accountInvalid"));
		return;
	}
	save({ accountId: value });
});

$("#copy-redirect").addEventListener("click", async () => {
	try {
		await navigator.clipboard.writeText($("#redirect-uri").textContent);
		flash(t("copied"));
	} catch {
		// Selecting the text still lets the user copy it by hand.
		getSelection().selectAllChildren($("#redirect-uri"));
	}
});

$("#connect-drive").addEventListener("click", async () => {
	const status = $("#drive-status");
	await save({ driveClientId: $("#drive-client-id").value.trim() });
	status.className = "small muted";
	status.textContent = t("driveConnecting");
	try {
		await send("connect-drive");
		status.className = "small ok";
		status.textContent = t("driveConnected");
	} catch (error) {
		status.className = "small bad";
		status.textContent = t("driveConnectFailed", error.message);
	}
});

$("#open-downloads").addEventListener("click", () => {
	chromeApi.downloads.showDefaultFolder();
});

$("#forget").addEventListener("click", async () => {
	if (!confirm(t("forgetConfirm"))) {
		return;
	}
	await clearLedger(storage);
	await renderLedger();
	flash(t("forgotten"));
});

chromeApi.storage.onChanged.addListener((changes, area) => {
	if (area === "local") {
		renderLedger();
		if (changes.settings) {
			renderAccountHelp(changes.settings.newValue ?? {});
		}
	}
});

watchRun((run) => {
	running = isActive(run);
	renderLedger();
});

localize();
load();
