// The message (in _locales) that tells the user why a run stopped and what to
// do next, by error code.
const hintKeys = {
	AUTH_EXPIRED: "hintAuthExpired",
	DRIVE_SIGN_IN: "hintDriveSignIn",
	NO_ACCOUNT_ID: "hintNoAccountId",
	NO_HISTORY: "hintNoHistory",
	NO_SIGN_IN: "hintNoSignIn",
	NO_TAB: "hintNoTab",
	SAVE_FAILED: "hintSaveFailed",
	TAB_UNAVAILABLE: "hintTabUnavailable"
};

export function hintKey(code) {
	return hintKeys[code] ?? "hintGeneric";
}
