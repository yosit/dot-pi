import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export type CompactionSettings = {
	enabled?: boolean;
	reserveTokens?: number;
	modelOverrides?: Record<string, { reserveTokens?: number }>;
};

function readCompaction(path: string): CompactionSettings {
	try {
		return JSON.parse(readFileSync(path, "utf8")).compaction ?? {};
	} catch {
		return {};
	}
}

/**
 * Mirrors pi's resolution: model override → setting → 16384 default; project
 * merges over user. `enabled` is global, not per-model. Null when auto-compaction is off.
 */
export function resolveReserve(user: CompactionSettings, project: CompactionSettings, modelKey: string): number | null {
	const merged: CompactionSettings = {
		...user,
		...project,
		modelOverrides: { ...user.modelOverrides, ...project.modelOverrides },
	};
	if (merged.enabled === false) return null;
	return merged.modelOverrides?.[modelKey]?.reserveTokens ?? merged.reserveTokens ?? 16384;
}

export function compactionReserve(cwd: string, modelKey: string): number | null {
	return resolveReserve(
		readCompaction(join(homedir(), ".pi", "agent", "settings.json")),
		readCompaction(join(cwd, ".pi", "settings.json")),
		modelKey,
	);
}
