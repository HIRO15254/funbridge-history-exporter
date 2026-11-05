// Words for a run's state, shared by the popup and the progress page.
import { familyName, formatDate, formatNumber, t } from "./common.js";

export function statusTitle(run) {
	const keys = {
		cancelled: "statusCancelled",
		connecting: "statusConnecting",
		done: "statusDone",
		failed: "statusFailed",
		interrupted: "statusInterrupted",
		listing: "statusListing",
		saving: "statusSaving",
		"waiting-sign-in": "statusWaitingSignIn"
	};
	return t(keys[run?.status] ?? "statusIdle");
}

export function tournamentLabel({ family, title, playedAt }) {
	return [familyName(family), title, formatDate(playedAt)]
		.filter(Boolean)
		.join(" · ");
}

function listingFamily(run) {
	return Object.entries(run.families).find(
		([, family]) => family.state === "listing"
	)?.[0];
}

export function currentLine(run) {
	if (!run) {
		return "";
	}
	if (run.status === "listing") {
		const family = listingFamily(run);
		return family ? t("readingFamily", familyName(family)) : "";
	}
	if (run.status === "connecting") {
		return t("connectingDetail");
	}
	if (!run.current) {
		return "";
	}
	const board =
		run.current.board > 0
			? run.current.boards
				? t("boardOf", [run.current.board, run.current.boards])
				: t("boardN", run.current.board)
			: t("startingTournament");
	return `${tournamentLabel(run.current)} — ${board}`;
}

export function countLine(run) {
	return run?.toFetch > 0
		? `${formatNumber(run.processed)} / ${formatNumber(run.toFetch)}`
		: "";
}

export function summaryLine(counts) {
	const parts = [
		t("summarySaved", formatNumber(counts.saved)),
		t("summaryAlready", formatNumber(counts.already))
	];
	if (counts.failed > 0) {
		parts.push(t("summaryFailed", formatNumber(counts.failed)));
	}
	return parts.join(" · ");
}
