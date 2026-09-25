/**
 * statusline — Claude-Code-style footer:
 *
 *   dir  branch● ↑1  ⚡Claude Opus 5.5 🧠high  ▮▮▯▯▯▯▯▯ 27% 108k/⟳400k/1M  ♻92%  ✚12 ✖3  💲1.84  🧠auto 91% 240ms
 *
 * The context bar measures against the auto-compaction point, not the full window.
 */
import { execFileSync } from "node:child_process";
import { basename } from "node:path";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { truncateToWidth } from "@earendil-works/pi-tui";
import { compactionReserve } from "../src/compaction.ts";
import { diffCounts, lineCount } from "../src/lines.ts";

const R = "\x1b[0m";
const BOLD = "\x1b[1m";
const DIM = "\x1b[2m";
const YELLOW = "\x1b[33m";
const GRAY = "\x1b[90m";
const B_RED = "\x1b[91m";
const B_GREEN = "\x1b[92m";
const B_YELLOW = "\x1b[93m";
const B_BLUE = "\x1b[94m";
const B_MAGENTA = "\x1b[95m";
const B_CYAN = "\x1b[96m";

function barColor(pct: number) {
	if (pct >= 90) return B_RED;
	if (pct >= 70) return B_YELLOW;
	if (pct >= 40) return B_CYAN;
	return B_GREEN;
}

const fmtK = (n: number) => (n < 1000 ? `${n}` : n >= 1_000_000 ? `${+(n / 1_000_000).toFixed(1)}M` : `${Math.round(n / 1000)}k`);

function git(args: string[], cwd: string): string | null {
	try {
		return execFileSync("git", args, { cwd, stdio: ["ignore", "pipe", "ignore"] }).toString().trim();
	} catch {
		return null;
	}
}

type GitState = { dirty: boolean; ahead: number; behind: number; hasUpstream: boolean };

function readGit(cwd: string): GitState {
	const dirty = (git(["status", "--porcelain"], cwd) ?? "") !== "";
	const counts = git(["rev-list", "--left-right", "--count", "@{upstream}...HEAD"], cwd);
	if (!counts) return { dirty, ahead: 0, behind: 0, hasUpstream: false };
	const [behind, ahead] = counts.split(/\s+/).map(Number);
	return { dirty, ahead: ahead || 0, behind: behind || 0, hasUpstream: true };
}

export default function (pi: ExtensionAPI) {
	let gitState: GitState = { dirty: false, ahead: 0, behind: 0, hasUpstream: false };
	let added = 0;
	let removed = 0;

	pi.on("tool_result", async (e) => {
		if (e.isError) return;
		if (e.toolName === "edit") {
			const edits = (e.input.edits ?? []) as { oldText?: string; newText?: string }[];
			for (const { oldText, newText } of edits) {
				const [a, r] = diffCounts(oldText ?? "", newText ?? "");
				added += a;
				removed += r;
			}
		} else if (e.toolName === "write") {
			added += lineCount(String(e.input.content ?? ""));
		}
	});

	let reserveCache: { key: string; value: number | null } | null = null;
	const reserveFor = (ctx: ExtensionContext) => {
		const key = ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : "";
		if (reserveCache?.key !== key) reserveCache = { key, value: compactionReserve(ctx.cwd, key) };
		return reserveCache.value;
	};

	const install = (ctx: ExtensionContext) => {
		if (ctx.mode !== "tui") return;
		gitState = readGit(ctx.cwd);
		reserveCache = null;
		ctx.ui.setFooter((tui, _theme, footerData) => {
			const unsub = footerData.onBranchChange(() => {
				gitState = readGit(ctx.cwd);
				tui.requestRender();
			});
			return {
				dispose: unsub,
				invalidate() {},
				render(width: number): string[] {
					let cost = 0;
					let input = 0;
					let cacheRead = 0;
					for (const e of ctx.sessionManager.getBranch()) {
						if (e.type === "message" && e.message.role === "assistant") {
							const u = (e.message as AssistantMessage).usage;
							cost += u.cost.total;
							input += u.input;
							cacheRead += u.cacheRead ?? 0;
						}
					}

					// Context bar + tokens, measured against the auto-compaction point
					const usage = ctx.getContextUsage();
					const reserve = reserveFor(ctx);
					const window = usage?.contextWindow ?? 0;
					const limit = reserve != null && window > reserve ? window - reserve : window;
					const used = usage?.tokens ?? null;
					const pct = used != null && limit > 0 ? Math.min(100, Math.floor((used / limit) * 100)) : 0;
					const c = barColor(pct);
					const filled = Math.floor((pct * 8) / 100);
					const bar = `${c}${"▮".repeat(filled)}${GRAY}${"▯".repeat(8 - filled)}${R}`;
					const usedStr = used != null ? fmtK(used) : "?";
					const tokens = !window
						? ""
						: limit < window
							? ` ${DIM}${usedStr}/⟳${fmtK(limit)}/${fmtK(window)}${R}`
							: ` ${DIM}${usedStr}/${fmtK(window)}${R}`;

					// Git
					const branch = footerData.getGitBranch();
					let gitSeg = "";
					if (branch) {
						gitSeg = `${B_MAGENTA} ${branch}${gitState.dirty ? "●" : ""}${R}`;
						if (gitState.hasUpstream && (gitState.ahead || gitState.behind)) {
							gitSeg += ` ${B_BLUE}${gitState.ahead ? `↑${gitState.ahead}` : ""}${gitState.behind ? `↓${gitState.behind}` : ""}${R}`;
						}
					}

					// Model + thinking
					const model = ctx.model?.name ?? ctx.model?.id ?? "no-model";
					const thinking =
						ctx.thinkingLevel && ctx.thinkingLevel !== "off" ? ` ${DIM}🧠${ctx.thinkingLevel}${R}` : "";

					// Cache hit
					const cacheTotal = input + cacheRead;
					const cache = cacheTotal > 0 ? `  ${DIM}♻${Math.round((cacheRead / cacheTotal) * 100)}%${R}` : "";

					const statuses = [...footerData.getExtensionStatuses().values()].join(" ");

					const line =
						`${BOLD}${B_CYAN} ${basename(ctx.cwd)}${R}${gitSeg}  ` +
						`${BOLD}${YELLOW}⚡${model}${R}${thinking}  ` +
						`${bar} ${c}${pct}%${R}${tokens}${cache}  ` +
						`${B_GREEN}✚${added}${R} ${B_RED}✖${removed}${R}  ` +
						`${DIM}💲${cost.toFixed(2)}${R}` +
						(statuses ? `  ${statuses}` : "");
					return [truncateToWidth(line, width)];
				},
			};
		});
	};

	pi.on("session_start", async (_e, ctx) => install(ctx));
	pi.on("turn_end", async (_e, ctx) => {
		gitState = readGit(ctx.cwd);
	});
}
