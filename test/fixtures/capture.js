// A single anonymised Daily board, shaped exactly like the Funbridge responses
// the extension observes, so the tests never need a live account.
export const timestamp = Date.UTC(2026, 8, 15, 12, 0, 0);

export const archive = {
	countDeal: 1,
	date: timestamp,
	finished: true,
	id: "9001",
	listPlayedDeals: ["7001"],
	name: "Daily fixture",
	nbPlayers: 2,
	rank: 1,
	result: 0.6,
	resultType: 1,
	title: "Daily fixture"
};

export const hero = {
	contract: "4S",
	dealIDstr: "7001",
	dealIndex: 1,
	gameID: 8001,
	lead: "2SW",
	nbTotalPlayer: 2,
	nbTricks: 10,
	rank: 1,
	result: 0.6,
	resultType: 1,
	score: 420
};

export const tournament = {
	beginDate: timestamp,
	countDeal: 1,
	nbTotalPlayer: 2,
	resultPlayer: { nbTotalPlayer: 2, rank: 1, result: 0.6 },
	resultType: 1
};

export const summary = {
	deal: {
		bidList: "1SN-PAE-4SS-PAW-PAN-PAE",
		contract: "4S",
		dealer: "N",
		declarer: "S",
		nbTricks: 10,
		playList: "2SW-ASN-TSE-6SS-!S9",
		playerHands: {
			east: "TS-9S-8S-7S-JH-TH-9H-8H-JD-TD-9D-JC-TC",
			north: "AS-KS-QS-JS-AH-KH-QH-AD-KD-QD-AC-KC-QC",
			south: "6S-5S-4S-3S-7H-6H-5H-8D-7D-6D-5D-7C-6C",
			west: "2S-4H-3H-2H-4D-3D-2D-9C-8C-5C-4C-3C-2C"
		},
		vulnerability: "L"
	},
	gameID: 8001,
	result: { listResultDeal: [hero], tournament }
};

export const groups = {
	listResultDeal: [
		{
			contract: "4S",
			declarer: "S",
			nbPlayerSameGame: 2,
			nbTricks: 10,
			rank: 1,
			result: 0.6,
			score: 420
		}
	],
	sourceTotalSize: 1,
	totalSize: 1
};

export const capture = {
	accountId: "123456",
	archive,
	boards: [{ boardNumber: 1, groups, summary }],
	family: "DAILY",
	seed: { listResultDeal: [hero], tournament }
};

export const capturedAt = new Date(timestamp).toISOString();
