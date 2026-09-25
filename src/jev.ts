import { execFile } from "node:child_process";
import { appendFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import type { Config } from "./config.ts";

/**
 * Minimal TypeSafe Jev client. Calls the HTTP API directly (no runline
 * subprocess), so a decision costs one round trip (~70-500ms).
 *
 * Every caller must treat `null` as "no opinion" and fail open: a guardrail
 * that blocks the agent because a classifier is down is worse than none.
 */

export type ChoiceQuestion = {
	id: string;
	type: "choice";
	instructions: string;
	options: { value: string; description?: string }[];
};
export type NoulQuestion = { id: string; type: "noul"; instructions: string; whenTrue?: string; whenFalse?: string };
export type Question = ChoiceQuestion | NoulQuestion;

export type ChoiceAnswer = {
	type: "choice";
	choice: string;
	confidence: number;
	probabilities: Record<string, number>;
};
export type NoulAnswer = { type: "noul"; noul: number };
export type Answers = Record<string, ChoiceAnswer | NoulAnswer | undefined>;

export type EvaluateResult = { answers: Answers; model: string; latencyMs: number; inputTokens?: number };

/** API wire shape: questions keyed by id, rubric under `criteria`. */
export function toWire(questions: Question[]): Record<string, unknown> {
	const wire = new Map<string, unknown>();
	for (const q of questions) {
		if (wire.has(q.id)) throw new Error(`duplicate question id ${q.id}`);
		if (q.type === "choice") {
			wire.set(q.id, {
				type: "choice",
				instructions: q.instructions,
				criteria: Object.fromEntries(q.options.map((o) => [o.value, o.description ?? null])),
			});
		} else {
			const criteria: Record<string, string> = {};
			if (q.whenTrue !== undefined) criteria.true = q.whenTrue;
			if (q.whenFalse !== undefined) criteria.false = q.whenFalse;
			wire.set(q.id, { type: "noul", instructions: q.instructions, ...(Object.keys(criteria).length ? { criteria } : {}) });
		}
	}
	return Object.fromEntries(wire);
}

let keyPromise: Promise<string | null> | null = null;

function psstGet(args: string[]): Promise<string | null> {
	return new Promise((resolve) => {
		execFile("psst", [...args, "get", "TYPESAFE_API_KEY"], { timeout: 5000 }, (err, stdout) => {
			const key = stdout?.trim();
			resolve(err || !key ? null : key);
		});
	});
}

/**
 * TYPESAFE_API_KEY from the environment, else the global psst vault, else the
 * project vault (psst does not fall back from project to global on its own).
 * A found key is cached for the process; a miss is retried on the next call
 * (e.g. after the vault is unlocked).
 */
export function apiKey(): Promise<string | null> {
	const env = process.env.TYPESAFE_API_KEY?.trim();
	if (env) return Promise.resolve(env);
	keyPromise ??= psstGet(["--global"])
		.then((k) => k ?? psstGet([]))
		.then((k) => {
			if (!k) keyPromise = null;
			return k;
		});
	return keyPromise;
}

export async function evaluate(
	cfg: Config["typesafe"],
	state: unknown,
	questions: Question[],
	signal?: AbortSignal,
): Promise<EvaluateResult | null> {
	const key = await apiKey();
	if (!key) return null;
	const started = Date.now();
	const timeout = AbortSignal.timeout(cfg.timeoutMs);
	try {
		const res = await fetch(`${cfg.baseUrl.replace(/\/+$/, "")}/v1/systemone`, {
			method: "POST",
			headers: { authorization: `Bearer ${key}`, "content-type": "application/json", accept: "application/json" },
			body: JSON.stringify({ state, model: cfg.model, questions: toWire(questions) }),
			signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
		});
		if (!res.ok) return null;
		const body = (await res.json()) as { answers?: Answers; model?: string; usage?: { input_tokens?: number } };
		if (!body.answers) return null;
		return {
			answers: body.answers,
			model: body.model ?? cfg.model,
			latencyMs: Date.now() - started,
			inputTokens: body.usage?.input_tokens,
		};
	} catch {
		return null;
	}
}

export function noul(a: Answers, id: string): number | null {
	const ans = a[id];
	return ans?.type === "noul" && typeof ans.noul === "number" ? ans.noul : null;
}

export function choice(a: Answers, id: string): ChoiceAnswer | null {
	const ans = a[id];
	return ans?.type === "choice" ? ans : null;
}

/** Append one decision to the JSONL log. Never throws. */
export async function logDecision(cfg: Config["typesafe"], record: Record<string, unknown>): Promise<void> {
	if (!cfg.logFile) return;
	try {
		await mkdir(dirname(cfg.logFile), { recursive: true });
		await appendFile(cfg.logFile, `${JSON.stringify({ ts: new Date().toISOString(), ...record })}\n`);
	} catch {
		// logging is best-effort
	}
}
