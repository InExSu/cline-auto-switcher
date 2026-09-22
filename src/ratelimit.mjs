// Rate-limit detection.
//
// RATE_LIMIT_PATTERNS is copied verbatim from Cline's own error classifier so
// the switcher reacts to exactly the errors Cline treats as limits:
//
//   apps/vscode/src/services/error/ClineError.ts
//   const RATE_LIMIT_PATTERNS = [/status code 429/i, /rate limit/i,
//     /too many requests/i, /quota exceeded/i, /resource exhausted/i]
//
// On top of those message patterns we classify the structured codes Cline
// emits, because they need different treatment: a spend cap or an empty wallet
// is not a transient throttle.

export const RATE_LIMIT_PATTERNS = [
	/status code 429/i,
	/rate limit/i,
	/too many requests/i,
	/quota exceeded/i,
	/resource exhausted/i,
];

/**
 * @typedef {object} Verdict
 * @property {boolean} isLimit    true when this error should trigger a switch
 * @property {string|null} kind   machine-readable reason
 * @property {boolean} terminal   true when the account cannot serve again soon
 * @property {string[]} matched   which patterns fired (for the log)
 */

/**
 * Classify an error message coming out of Cline.
 * @param {string} rawMessage
 * @returns {Verdict}
 */
export function classifyError(rawMessage) {
	const message = String(rawMessage ?? "");
	const matched = RATE_LIMIT_PATTERNS.filter((re) => re.test(message)).map(String);

	// Org-enforced budget cap. Still a 429, and rotating is the only lever we
	// have — but it may follow the user into a sibling account in the same org.
	if (/spend_limit_exceeded/i.test(message)) {
		return { isLimit: true, kind: "spend_limit", terminal: false, matched };
	}

	// Wallet empty / not subscribed. This account is done until the user tops
	// up, so park it for a long time rather than retrying it in a minute.
	if (/insufficient_credits|not enough credits|credits_exhausted/i.test(message)) {
		return { isLimit: true, kind: "credits", terminal: true, matched };
	}

	if (/inference_cap_error/i.test(message)) {
		return { isLimit: true, kind: "quota_exceeded", terminal: false, matched };
	}

	// Subscription-tier ceilings (ClinePass / free-model buckets). Transient:
	// the bucket refills, so a normal cooldown is right.
	if (/cline_free_model_limit|cline_?pass_limit|cline pass limit/i.test(message)) {
		return { isLimit: true, kind: "rate_limit", terminal: false, matched };
	}

	// Auth problems must NOT trigger a switch: rotating a dead token into
	// another slot just hides the real problem and can log the user out.
	if (/requires re-authentication|invalid_grant|authentication failed|invalid[_-]?token|unauthorized/i.test(message)) {
		return { isLimit: false, kind: "auth", terminal: false, matched };
	}

	if (matched.length > 0) {
		return { isLimit: true, kind: "rate_limit", terminal: false, matched };
	}

	return { isLimit: false, kind: null, terminal: false, matched };
}

/** Human-readable summary used in logs and CLI output. */
export function describeVerdict(verdict) {
	if (!verdict.isLimit) return verdict.kind ? `ignored (${verdict.kind})` : "ignored (not a limit)";
	return verdict.terminal ? `${verdict.kind} (terminal)` : verdict.kind;
}
