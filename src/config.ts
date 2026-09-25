import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/**
 * dot-pi config. Read from ~/.pi/agent/dot-pi.json, then <cwd>/.pi/dot-pi.json
 * (project wins, deep-merged). Every field is optional; defaults below.
 */
export type Config = {
	typesafe: {
		/** Pin a version once thresholds are tuned against it. */
		model: string;
		baseUrl: string;
		timeoutMs: number;
		/** Append every Jev decision to this JSONL file (tuning data). Empty string disables. */
		logFile: string;
	};
	autothink: { enabled: boolean; confidenceFloor: number };
	settleGate: {
		verify: {
			enabled: boolean;
			/** Regexes (source strings) matching a bash command that counts as verification. */
			commands: string[];
			threshold: number;
		};
		ask: { enabled: boolean; threshold: number; toolName: string };
	};
	loopDetector: {
		enabled: boolean;
		threshold: number;
		/** How many recent tool results Jev sees. */
		window: number;
		/** Minimum errors inside the window before Jev is asked at all. */
		minErrors: number;
		/** Raise the thinking level to this when a loop is detected ("" to leave it). */
		escalateThinking: string;
	};
};

export const DEFAULTS: Config = {
	typesafe: {
		model: "jev-1.13.0",
		baseUrl: "https://api.typesafe.ai",
		timeoutMs: 4000,
		logFile: join(homedir(), ".pi", "agent", "dot-pi", "decisions.jsonl"),
	},
	autothink: { enabled: true, confidenceFloor: 0.6 },
	settleGate: {
		verify: {
			enabled: true,
			commands: [
				"\\b(bun|npm|pnpm|yarn)\\s+(run\\s+)?(check|test|lint|typecheck|build)\\b",
				"\\btsc\\b",
				"\\bcargo\\s+(test|check|clippy)\\b",
				"\\bgo\\s+(test|vet)\\b",
				"\\bpytest\\b",
				"\\bmake\\s+(test|check)\\b",
			],
			threshold: 0.7,
		},
		ask: { enabled: true, threshold: 0.75, toolName: "AskUserQuestion" },
	},
	loopDetector: { enabled: true, threshold: 0.7, window: 6, minErrors: 3, escalateThinking: "high" },
};

type DeepPartial<T> = { [K in keyof T]?: T[K] extends object ? (T[K] extends unknown[] ? T[K] : DeepPartial<T[K]>) : T[K] };

function readJson(path: string): DeepPartial<Config> {
	try {
		return JSON.parse(readFileSync(path, "utf8"));
	} catch {
		return {};
	}
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
	return typeof v === "object" && v !== null && !Array.isArray(v);
}

export function merge<T>(base: T, over: unknown): T {
	if (!isPlainObject(base) || !isPlainObject(over)) return (over === undefined ? base : over) as T;
	const out: Record<string, unknown> = { ...base };
	for (const [k, v] of Object.entries(over)) out[k] = merge((base as Record<string, unknown>)[k], v);
	return out as T;
}

export function loadConfig(cwd: string): Config {
	const user = readJson(join(homedir(), ".pi", "agent", "dot-pi.json"));
	const project = readJson(join(cwd, ".pi", "dot-pi.json"));
	return merge(merge(DEFAULTS, user), project);
}
