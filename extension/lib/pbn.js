const seatKeys = { north: "N", east: "E", south: "S", west: "W" };
const seatOrder = ["N", "E", "S", "W"];
const vulnerabilities = { A: "Both", E: "EW", L: "None", N: "NS" };
const contractPattern = /^([1-7])([CDHSN])(X1|X2)?$/;
const cardPattern = /^([2-9AKQJT])([CDHS])([ENWS])$/;
const bidPattern = /^(PA|X1|X2|[1-7][CDHSN])([ENWS])(A?)$/;
const rankOrder = "AKQJT98765432";
const robotName = "Argine";
const heroSeat = "S";
const alertNote = "1";

const positiveInteger = (value) => Number.isInteger(value) && value > 0;
const number = (value) => typeof value === "number" && Number.isFinite(value);
const firstPositive = (...values) => values.find(positiveInteger);

// Mandatory tag pairs of PBN 2.1 section 3.4, emitted in the order the standard
// prescribes and always present even when the source response has no value.
const mandatoryTags = [
	"Event",
	"Site",
	"Date",
	"Board",
	"West",
	"North",
	"East",
	"South",
	"Dealer",
	"Vulnerable",
	"Deal",
	"Scoring",
	"Declarer",
	"Contract",
	"Result"
];

function sourceId(value) {
	if (
		value === undefined ||
		value === null ||
		value === "" ||
		value === 0 ||
		value === -1 ||
		value === "0" ||
		value === "-1"
	) {
		return undefined;
	}
	return String(value);
}

function iso(value) {
	const date = new Date(value);
	if (Number.isNaN(date.getTime())) {
		throw new Error(`日時を解釈できません: ${value}`);
	}
	return date.toISOString();
}

// PBN carries a calendar date, so the instant is resolved in the player's own
// zone. The exact instant stays available in the FunbridgePlayedAt tag.
function localDate(isoString) {
	return new Intl.DateTimeFormat("sv-SE", { timeZone: "Asia/Tokyo" }).format(
		new Date(isoString)
	);
}

function resultType(value) {
	if (value === 1 || value === "RESULT_PERCENTAGE") {
		return "MP";
	}
	if (value === 2 || value === "RESULT_IMP") {
		return "IMP";
	}
	throw new Error(`未対応のresultTypeです: ${value}`);
}

function score(value, type) {
	if (!number(value)) {
		return undefined;
	}
	return type === "MP" ? value * 100 : value;
}

function rawScore(value) {
	return number(value) && value !== -32_000 ? value : undefined;
}

function contract(value) {
	if (!value || value === "PA") {
		return undefined;
	}
	const match = contractPattern.exec(value);
	if (!match) {
		throw new Error(`未対応のcontractです: ${value}`);
	}
	const denomination = match[2] === "N" ? "NT" : match[2];
	const doubled = { X1: "X", X2: "XX" }[match[3]] ?? "";
	return `${match[1]}${denomination}${doubled}`;
}

function card(value) {
	if (!value) {
		return undefined;
	}
	const match = cardPattern.exec(value);
	if (!match) {
		throw new Error(`未対応のcardです: ${value}`);
	}
	return `${match[2]}${match[1]}`;
}

function nextSeat(seat, offset) {
	return seatOrder[(seatOrder.indexOf(seat) + offset) % 4] ?? "N";
}

function normalizeHands(playerHands) {
	return Object.fromEntries(
		Object.entries(seatKeys).map(([name, seat]) => {
			const tokens = playerHands?.[name]?.split("-") ?? [];
			const hand = [..."SHDC"]
				.map((suit) =>
					tokens
						.filter((token) => token.endsWith(suit))
						.map((token) => token[0])
						.sort(
							(left, right) =>
								rankOrder.indexOf(left) - rankOrder.indexOf(right)
						)
						.join("")
				)
				.join(".");
			return [seat, hand];
		})
	);
}

function normalizeAuction(value) {
	if (!value) {
		return [];
	}
	return value.split("-").map((token) => {
		const match = bidPattern.exec(token);
		if (!match) {
			throw new Error(`未対応のbidです: ${token}`);
		}
		const call =
			{ PA: "Pass", X1: "X", X2: "XX" }[match[1]] ??
			match[1].replace("N", "NT");
		return { alerted: match[3] === "A", call, seat: match[2] };
	});
}

function normalizePlay(value) {
	const actions = [];
	let claimMarker;
	for (const token of value ? value.split("-") : []) {
		if (token.startsWith("!")) {
			claimMarker = token;
			continue;
		}
		const match = cardPattern.exec(token);
		if (!match) {
			throw new Error(`未対応のplayです: ${token}`);
		}
		actions.push({
			card: `${match[2]}${match[1]}`,
			seat: match[3],
			trickNumber: Math.floor(actions.length / 4) + 1
		});
	}
	return { actions, claimMarker };
}

function escapeValue(value) {
	return String(value).replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

function auctionLines(calls) {
	if (calls.length === 0) {
		return [];
	}
	const tokens = calls.map((entry) =>
		entry.alerted ? `${entry.call} =${alertNote}=` : entry.call
	);
	const lines = [];
	for (let offset = 0; offset < tokens.length; offset += 4) {
		lines.push(tokens.slice(offset, offset + 4).join(" "));
	}
	return lines;
}

// A PBN play section lays every trick out in fixed seat columns starting at the
// opening leader, so a seat that did not play to a trick keeps a "-" column.
function playLines(actions, leader) {
	const trickNumbers = [...new Set(actions.map((entry) => entry.trickNumber))];
	return trickNumbers.map((trickNumber) => {
		const trick = actions.filter((entry) => entry.trickNumber === trickNumber);
		return Array.from({ length: 4 }, (_, column) => {
			const seat = nextSeat(leader, column);
			return trick.find((entry) => entry.seat === seat)?.card ?? "-";
		}).join(" ");
	});
}

function renderGame(game) {
	const extra = Object.keys(game.tags)
		.filter((name) => !mandatoryTags.includes(name))
		.sort();
	const lines = [...mandatoryTags, ...extra].map(
		(name) => `[${name} "${escapeValue(game.tags[name] ?? "?")}"]`
	);
	if (game.auction?.length) {
		if (game.auction.some((entry) => entry.alerted)) {
			lines.push(`[Note "${alertNote}:Alerted"]`);
		}
		lines.push(`[Auction "${game.dealer}"]`);
		lines.push(...auctionLines(game.auction));
		if (game.incompleteAuction) {
			lines.push("*");
		}
	}
	if (game.play?.length) {
		const leader = game.play[0].seat;
		lines.push(`[Play "${leader}"]`);
		lines.push(...playLines(game.play, leader));
		if (game.play.length < 52) {
			lines.push("*");
		}
	}
	return lines;
}

export function renderPbn(games, generator) {
	const lines = [
		"% PBN 2.1",
		"% EXPORT",
		"%Content-type: text/x-pbn; charset=UTF-8",
		`% ${generator}`,
		""
	];
	for (const game of games) {
		lines.push(...renderGame(game), "");
	}
	return `${lines.join("\n").trimEnd()}\n`;
}

function archiveId(row) {
	return sourceId(
		row.sourceTournamentId ??
			row.tournamentID ??
			row.tourIDstr ??
			row.id ??
			row.ID
	);
}

function archiveName(row) {
	return row.title ?? row.name ?? "Funbridge Tournament";
}

function summaryTournament(summary) {
	return summary?.result?.tournament ?? summary?.tournament;
}

function summaryRows(summary) {
	return summary?.result?.listResultDeal ?? summary?.heroRows ?? [];
}

function heroFor(boardNumber, summary, seed, dealId) {
	const rows = summaryRows(summary);
	return (
		rows.find(
			(row) =>
				row.dealIndex === boardNumber &&
				sourceId(row.dealIDstr ?? row.dealID) === dealId
		) ??
		rows.find((row) => row.dealIndex === boardNumber) ??
		seed?.listResultDeal?.find((row) => row.dealIndex === boardNumber)
	);
}

function bpCircuitTags(capture, archive) {
	const coefficient =
		archive.coefficient ?? capture.parentEvent?.coefficient ?? "BP";
	const level =
		(coefficient.startsWith("BP") ? coefficient.slice(2) : coefficient) ||
		"UNKNOWN";
	let kind = "FEDERAL";
	if (capture.kind === "KNOCKOUT") {
		kind = "KNOCKOUT";
	} else if (capture.parentEvent) {
		kind = "BIC";
	}
	const awarded =
		capture.seed?.tournament?.resultPlayer?.bridgePoints ??
		archive.bridgePoints;
	return {
		FunbridgeCoefficient: coefficient,
		FunbridgeKind: kind,
		FunbridgeLevel: level,
		...(Number(level) > 0
			? { FunbridgeMultiplier: String(Number(level) / 100) }
			: {}),
		...(number(awarded) && awarded >= 0
			? { FunbridgeAwarded: String(awarded) }
			: {}),
		...(capture.parentEvent
			? { FunbridgeParentEventId: archiveId(capture.parentEvent) ?? "?" }
			: {}),
		...(capture.kind === "KNOCKOUT"
			? {
					FunbridgeKnockoutRounds: capture.matches
						.map(({ match }) =>
							[
								match.roundNumber,
								match.id,
								match.status,
								match.nbDeals,
								sourceId(match.player2?.playerID ?? match.player2ID) ?? "",
								match.scorePlayer1,
								match.scorePlayer2,
								sourceId(match.winner) ?? ""
							].join(",")
						)
						.join(";")
				}
			: {})
	};
}

function seriesTags(archive) {
	const period = String(archive.periodID ?? "");
	const [start, end] = period.split(";").map(Number);
	return {
		FunbridgeLevel: archive.name ?? "?",
		FunbridgeOutcome: "PENDING",
		FunbridgePeriod: period,
		...(number(start) ? { FunbridgePeriodStartAt: iso(start) } : {}),
		...(number(end) ? { FunbridgePeriodEndAt: iso(end) } : {})
	};
}

function dailyTags(archive, seedTournament) {
	return {
		FunbridgeRegion: archive.name ?? "?",
		...(number(seedTournament?.endDate)
			? { FunbridgeEndAt: iso(seedTournament.endDate) }
			: {})
	};
}

// The history-index row is the only source for registration, progress and
// Bridge Points, so it is folded into every board of the tournament instead of
// being written to a separate index file.
// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: one contract keeps every family's tournament header in a single place.
function tournamentContext(family, capture, capturedAt) {
	const archive = capture.archive;
	const seedTournament =
		capture.seed?.tournament ?? summaryTournament(capture.boards[0]?.summary);
	const resultPlayer = seedTournament?.resultPlayer;
	const id = archiveId(archive);
	if (!id) {
		throw new Error("履歴行に大会IDがありません。");
	}
	const scoreType = resultType(
		seedTournament?.resultType ?? archive.resultType ?? 1
	);
	const boardCount =
		seedTournament?.countDeal ?? archive.countDeal ?? capture.boards.length;
	const playedBoardCount = capture.boards.length;
	const playedAt = iso(
		archive.startDate ?? seedTournament?.beginDate ?? archive.date
	);
	const tournamentScore = score(
		resultPlayer?.result ?? archive.result,
		scoreType
	);
	const rank = firstPositive(resultPlayer?.rank, archive.rank);
	const participantCount = firstPositive(
		resultPlayer?.nbTotalPlayer,
		seedTournament?.nbTotalPlayer,
		archive.registeredPlayerCount,
		archive.nbPlayers
	);
	const registered = firstPositive(
		archive.nbPlayers,
		archive.registeredPlayerCount
	);
	const familyTags = {
		BP_CIRCUIT: () => bpCircuitTags(capture, archive),
		DAILY: () => dailyTags(archive, seedTournament),
		SERIES: () => seriesTags(archive)
	}[family];
	return {
		id,
		playedAt,
		scoreType,
		shared: {
			Event: capture.parentEvent?.title ?? archiveName(archive),
			Site: "Funbridge",
			Date: localDate(playedAt).replaceAll("-", "."),
			West: robotName,
			North: robotName,
			East: robotName,
			South: String(capture.accountId ?? "?"),
			Scoring: scoreType,
			FunbridgeTournamentId: id,
			FunbridgeTournamentFamily: family,
			FunbridgePlayerId: String(capture.accountId ?? "?"),
			FunbridgePlayedAt: playedAt,
			FunbridgeCompletion:
				archive.inProgress ||
				archive.finished === false ||
				playedBoardCount < boardCount
					? "IN_PROGRESS"
					: "COMPLETED",
			FunbridgeBoardCount: String(boardCount),
			FunbridgePlayedBoardCount: String(playedBoardCount),
			FunbridgeTournamentScore:
				tournamentScore === undefined ? "?" : String(tournamentScore),
			FunbridgeRank: rank === undefined ? "?" : String(rank),
			FunbridgeParticipantCount:
				participantCount === undefined ? "?" : String(participantCount),
			FunbridgeCapturedAt: capturedAt,
			FunbridgeCaptureMode: "NETWORK_RESPONSE",
			...(registered === undefined
				? {}
				: { FunbridgeRegisteredPlayerCount: String(registered) }),
			...(family === "SERIES" && number(archive.date)
				? { FunbridgeLastPlayedAt: iso(archive.date) }
				: {}),
			...familyTags()
		}
	};
}

// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: Funbridge contract rows require explicit sentinel and integrity handling.
function contractGroupTags(groupSource, hero, scoreType) {
	if (!groupSource) {
		return {
			FunbridgeContractGroupCoverage: "NONE",
			FunbridgeContractGroupIntegrity: "UNKNOWN"
		};
	}
	const rows = groupSource.listResultDeal ?? groupSource.rows ?? [];
	const groups = [];
	let passedOutPlayerCount = 0;
	let unclassifiedPlayerCount = 0;
	for (const row of rows) {
		const playerCount = row.nbPlayerSameGame;
		if (!positiveInteger(playerCount)) {
			throw new Error("契約集計の人数が正の整数ではありません。");
		}
		if (row.contract === "PA") {
			passedOutPlayerCount += playerCount;
			continue;
		}
		const parsed = contractPattern.test(row.contract ?? "")
			? contract(row.contract)
			: undefined;
		const rowScore = score(row.result, scoreType);
		if (
			!(
				parsed &&
				seatOrder.includes(row.declarer) &&
				positiveInteger(row.rank) &&
				Number.isInteger(row.nbTricks)
			) ||
			rawScore(row.score) === undefined ||
			rowScore === undefined
		) {
			unclassifiedPlayerCount += playerCount;
			continue;
		}
		groups.push(
			[
				row.rank,
				parsed,
				row.declarer,
				row.nbTricks,
				row.score,
				rowScore,
				playerCount
			].join(",")
		);
	}
	const participantSum = rows.reduce(
		(sum, row) => sum + row.nbPlayerSameGame,
		0
	);
	const sourceTotalCount = groupSource.sourceTotalSize ?? groupSource.totalSize;
	let integrity = "UNKNOWN";
	if (positiveInteger(hero?.nbTotalPlayer)) {
		integrity =
			participantSum === hero.nbTotalPlayer ? "RECONCILED" : "MISMATCH";
	}
	return {
		FunbridgeContractGroupCoverage:
			sourceTotalCount === 0 || sourceTotalCount === rows.length
				? "FULL"
				: "VISIBLE_WINDOW",
		FunbridgeContractGroupIntegrity: integrity,
		FunbridgeContractGroupParticipantSum: String(participantSum),
		FunbridgeContractGroupRowCount: String(rows.length),
		...(groups.length ? { FunbridgeContractGroups: groups.join(";") } : {}),
		...(positiveInteger(sourceTotalCount)
			? { FunbridgeContractGroupSourceTotal: String(sourceTotalCount) }
			: {}),
		...(passedOutPlayerCount
			? { FunbridgePassedOutPlayerCount: String(passedOutPlayerCount) }
			: {}),
		...(unclassifiedPlayerCount
			? { FunbridgeUnclassifiedPlayerCount: String(unclassifiedPlayerCount) }
			: {})
	};
}

function comparisonTags(hero, groups, fallbackType) {
	if (
		!(hero && positiveInteger(hero.rank) && positiveInteger(hero.nbTotalPlayer))
	) {
		return {};
	}
	const scoreType = resultType(hero.resultType ?? fallbackType);
	const boardScore = score(hero.result, scoreType);
	return {
		FunbridgeBoardParticipantCount: String(hero.nbTotalPlayer),
		FunbridgeBoardRank: String(hero.rank),
		...(boardScore === undefined
			? {}
			: { FunbridgeBoardScore: String(boardScore) }),
		...(rawScore(hero.score) === undefined
			? {}
			: { FunbridgeBoardRawScore: String(hero.score) }),
		...(hero.lead ? { FunbridgeLead: card(hero.lead) } : {}),
		...contractGroupTags(groups, hero, scoreType)
	};
}

function dealTag(dealer, hands) {
	const order = Array.from({ length: 4 }, (_, offset) =>
		nextSeat(dealer, offset)
	);
	return `${dealer}:${order.map((seat) => hands[seat]).join(" ")}`;
}

function resolveDealId(boardNumber, capture, summary) {
	const seedHero = capture.seed?.listResultDeal?.find(
		(row) => row.dealIndex === boardNumber
	);
	const summaryHero = summaryRows(summary).find(
		(row) => row.dealIndex === boardNumber
	);
	return (
		sourceId(seedHero?.dealIDstr) ??
		sourceId(seedHero?.dealID) ??
		sourceId(capture.archive.listPlayedDeals?.[boardNumber - 1]) ??
		sourceId(summaryHero?.dealIDstr ?? summaryHero?.dealID)
	);
}

// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: a board is classified from several independent incomplete-response states.
function standardGame(entry, capture, context) {
	const { boardNumber, groups, summary } = entry;
	const deal = summary.deal;
	const dealId = resolveDealId(boardNumber, capture, summary);
	if (!dealId) {
		throw new Error(`ボード${boardNumber}のsourceDealIdがありません。`);
	}
	const hero = heroFor(boardNumber, summary, capture.seed, dealId);
	if (!hero) {
		throw new Error(`ボード${boardNumber}の本人結果がありません。`);
	}
	const parsedPlay = normalizePlay(deal.playList);
	const parsedContract = contract(deal.contract);
	const passedOut = deal.contract === "PA";
	const hasDeclarer = seatOrder.includes(deal.declarer);
	const comparison = comparisonTags(hero, groups, context.scoreType);
	let status = "PLAYED";
	if (passedOut) {
		status = "PASSED_OUT";
	} else if (!parsedContract) {
		status = "NO_CONTRACT_OR_PLAY";
	} else if (!(deal.playList && hasDeclarer)) {
		status = "NO_PLAY";
	}
	const tricks =
		parsedContract && Number.isInteger(deal.nbTricks)
			? String(deal.nbTricks)
			: "?";
	return {
		auction: normalizeAuction(deal.bidList),
		dealer: deal.dealer,
		incompleteAuction: false,
		play: parsedPlay.actions,
		tags: {
			...context.shared,
			Board: String(boardNumber),
			Dealer: deal.dealer,
			Vulnerable: vulnerabilities[deal.vulnerability] ?? "?",
			Deal: dealTag(deal.dealer, normalizeHands(deal.playerHands)),
			Declarer: passedOut ? "" : hasDeclarer ? deal.declarer : "?",
			Contract: passedOut ? "Pass" : (parsedContract ?? "?"),
			Result: passedOut ? "0" : tricks,
			FunbridgeBoardStatus: status,
			FunbridgeHeroSeat: heroSeat,
			FunbridgeSourceDealId: dealId,
			...(sourceId(summary.gameID)
				? { FunbridgeSourceGameId: sourceId(summary.gameID) }
				: {}),
			...(parsedPlay.claimMarker
				? { FunbridgeClaimMarker: parsedPlay.claimMarker }
				: {}),
			...comparison
		}
	};
}

// Knockout summaries expose the head-to-head result instead of a field, and the
// deal responses carry no play, so those boards keep only auction and match tags.
function knockoutGame(entry, capture, context) {
	const matchEntry = capture.matches.find(
		({ match }) => String(match.id) === String(entry.matchId)
	);
	const dealEntry = matchEntry?.dealList?.find(
		(deal) => String(deal.dealIDstr) === String(entry.sourceDealId)
	);
	if (!dealEntry) {
		throw new Error(
			`KOボード${entry.roundNumber}:${entry.boardNumber}のmatch結果がありません。`
		);
	}
	const deal = entry.summary.deal;
	const passedOut = deal.contract === "PA";
	const opponentContract = contract(dealEntry.contractPlayer2);
	return {
		auction: normalizeAuction(deal.bidList),
		dealer: deal.dealer,
		incompleteAuction: false,
		play: [],
		tags: {
			...context.shared,
			Board: String(entry.exportBoardNumber),
			Dealer: deal.dealer,
			Vulnerable: vulnerabilities[deal.vulnerability] ?? "?",
			Deal: dealTag(deal.dealer, normalizeHands(deal.playerHands)),
			Declarer: passedOut ? "" : "?",
			Contract: passedOut ? "Pass" : (contract(deal.contract) ?? "?"),
			Result: passedOut ? "0" : "?",
			FunbridgeBoardStatus: passedOut ? "PASSED_OUT" : "NO_CONTRACT_OR_PLAY",
			FunbridgeHeroSeat: heroSeat,
			FunbridgeMatchBoardNumber: String(entry.boardNumber),
			FunbridgeRoundNumber: String(entry.roundNumber),
			FunbridgeSourceDealId: String(dealEntry.dealIDstr),
			FunbridgeSourceMatchId: String(entry.matchId),
			...(sourceId(entry.summary.gameID)
				? { FunbridgeSourceGameId: sourceId(entry.summary.gameID) }
				: {}),
			...(number(dealEntry.result)
				? { FunbridgeImpDelta: String(dealEntry.result) }
				: {}),
			...(rawScore(dealEntry.scorePlayer1) === undefined
				? {}
				: { FunbridgeBoardRawScore: String(dealEntry.scorePlayer1) }),
			...(rawScore(dealEntry.scorePlayer2) === undefined
				? {}
				: { FunbridgeOpponentRawScore: String(dealEntry.scorePlayer2) }),
			...(opponentContract
				? {
						FunbridgeOpponentContract: opponentContract,
						FunbridgeOpponentTricks: String(dealEntry.nbTricksPlayer2)
					}
				: {})
		}
	};
}

export function buildTournamentPbn(family, capture, capturedAt, generator) {
	const context = tournamentContext(family, capture, capturedAt);
	const games = capture.boards.map((entry) =>
		capture.kind === "KNOCKOUT"
			? knockoutGame(entry, capture, context)
			: standardGame(entry, capture, context)
	);
	return {
		sourceTournamentId: context.id,
		playedAt: context.playedAt,
		text: renderPbn(games, generator)
	};
}

export function pbnFileName(familyDirectory, built) {
	return `funbridge-export/${familyDirectory}/${localDate(built.playedAt)}_${built.sourceTournamentId}.pbn`;
}
