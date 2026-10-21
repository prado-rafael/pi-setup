import { calculateCost, type AssistantMessage } from "@earendil-works/pi-ai";
import { SettingsManager, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { truncateToWidth } from "@earendil-works/pi-tui";

type Segment = {
  type: string;
  label: string;
  color?: string;
};

// Keep the footer layout here; compaction thresholds come from Pi's effective settings.
const LINES: Segment[][] = [
  [
    { type: "model", label: "Model", color: "cyan" },
    { type: "context-length", label: "Context", color: "brightBlack" },
    { type: "git-branch", label: "Branch", color: "magenta" },
    { type: "git-changes", label: "Changes", color: "yellow" },
  ],
  [
    { type: "thinking-effort", label: "Thinking", color: "brightBlack" },
    { type: "compaction-counter", label: "Compactions" },
    { type: "min-request-cost", label: "$Min/req" },
    { type: "session-clock", label: "Session" },
    { type: "session-cost", label: "Cost" },
    { type: "session-name", label: "Name" },
  ],
];

const GIT_CACHE_TTL_MS = 5_000;

function compactNumber(value: number): string {
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`;
  if (value >= 1_000) return `${(value / 1_000).toFixed(1)}k`;
  return `${Math.round(value)}`;
}

function elapsed(seconds: number): string {
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const secs = Math.floor(seconds % 60);
  return hours > 0
    ? `${hours}:${String(minutes).padStart(2, "0")}h`
    : `${minutes}:${String(secs).padStart(2, "0")}`;
}

function themeColor(color: string | undefined): string {
  switch (color) {
    case "cyan": return "accent";
    case "brightBlack": return "dim";
    case "magenta": return "accent";
    case "yellow": return "warning";
    default: return "muted";
  }
}

function usageColor(percent: number): string {
  if (percent <= 60) return "success";
  if (percent < 80) return "warning";
  return "error";
}

function minRequestCost(model: NonNullable<ExtensionContext["model"]>, tokens: number | undefined): string {
  if (tokens == null || !model.cost) return "?";

  const cost = calculateCost(model, {
    input: 0,
    output: 0,
    cacheRead: tokens,
    cacheWrite: 0,
    totalTokens: tokens,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  }).cacheRead;
  // A zero catalog rate can mean that pricing is unavailable, not that requests are free.
  if (!Number.isFinite(cost) || cost < 0 || (cost === 0 && (tokens !== 0 || model.cost.cacheRead <= 0))) return "?";
  return cost > 0 && cost < 0.001 ? "<0.001" : cost.toFixed(3);
}

export default function (pi: ExtensionAPI) {
  let currentContext: ExtensionContext | undefined;
  let tui: { requestRender(): void } | undefined;
  let sessionStartedAt = Date.now();
  let lastGitRefresh = 0;
  let gitRefreshInFlight = false;
  let gitChanges = { added: 0, modified: 0, deleted: 0, renamed: 0, untracked: 0 };

  async function refreshGit(ctx: ExtensionContext) {
    if (gitRefreshInFlight || Date.now() - lastGitRefresh < GIT_CACHE_TTL_MS) return;
    gitRefreshInFlight = true;
    try {
      const result = await ctx.exec(
        "git",
        ["status", "--porcelain=v1", "--untracked-files=normal"],
        { cwd: ctx.cwd, timeout: 2000 },
      );
      if (result.code === 0) {
        const next = { added: 0, modified: 0, deleted: 0, renamed: 0, untracked: 0 };
        for (const line of result.stdout.split("\n")) {
          if (!line) continue;
          const status = line.slice(0, 2);
          if (status === "??") {
            next.untracked++;
            continue;
          }
          if (status.includes("A")) next.added++;
          if (status.includes("M")) next.modified++;
          if (status.includes("D")) next.deleted++;
          if (status.includes("R")) next.renamed++;
        }
        gitChanges = next;
      }
    } catch {
      // Git status is supplementary; keep the last known value if it fails.
    } finally {
      lastGitRefresh = Date.now();
      gitRefreshInFlight = false;
      tui?.requestRender();
    }
  }

  function update(ctx: ExtensionContext) {
    currentContext = ctx;
    void refreshGit(ctx);
    tui?.requestRender();
  }

  pi.on("session_start", (_event, ctx) => {
    currentContext = ctx;
    const timestamp = ctx.sessionManager.getHeader()?.timestamp;
    sessionStartedAt = timestamp ? Date.parse(timestamp) || Date.now() : Date.now();

    if (ctx.mode !== "tui") return;

    ctx.ui.setFooter((activeTui, theme, footerData) => {
      tui = activeTui;
      const unsubscribe = footerData.onBranchChange(() => activeTui.requestRender());

      return {
        dispose() {
          unsubscribe();
          if (tui === activeTui) tui = undefined;
        },
        invalidate() {},
        render(width: number): string[] {
          const ctx = currentContext;
          if (!ctx) return [];

          const entries = ctx.sessionManager.getBranch();
          let cost = 0;
          for (const entry of entries) {
            if (entry.type === "message" && entry.message.role === "assistant") {
              cost += (entry.message as AssistantMessage).usage.cost.total;
            } else if ((entry.type === "compaction" || entry.type === "branch_summary") && entry.usage) {
              cost += entry.usage.cost.total;
            }
          }

          const contextUsage = ctx.getContextUsage();
          const contextTokens = contextUsage?.tokens;
          const contextWindow = contextUsage?.contextWindow ?? ctx.model?.contextWindow;
          const compactions = entries.filter((entry) => entry.type === "compaction").length;
          const branch = footerData.getGitBranch();
          const sessionSeconds = Math.max(0, (Date.now() - sessionStartedAt) / 1000);
          const gitStatus = [
            gitChanges.added ? `+${gitChanges.added}` : "",
            gitChanges.modified ? `~${gitChanges.modified}` : "",
            gitChanges.deleted ? `-${gitChanges.deleted}` : "",
            gitChanges.renamed ? `>${gitChanges.renamed}` : "",
            gitChanges.untracked ? `?${gitChanges.untracked}` : "",
          ].filter(Boolean).join(" ") || "clean";

          function valueFor(type: string): string {
            switch (type) {
              case "model": return ctx.model?.id ?? "no model";
              case "context-length": {
                const used = contextTokens == null ? "?" : compactNumber(contextTokens);
                if (!ctx.model || contextWindow == null) return `${used}/unknown`;

                const settings = SettingsManager.inMemory({ compaction: pi.getSettings().compaction });
                let compaction;
                try {
                  compaction = settings.getCompactionSettings(ctx.model);
                } catch {
                  return `${used}/invalid settings`;
                }

                if (!compaction.enabled) {
                  const percent = contextUsage?.percent;
                  const percentage = percent == null
                    ? ""
                    : ` (${theme.fg(usageColor(percent), `${Math.round(percent)}%`)})`;
                  return `${used}/${compactNumber(contextWindow)}${percentage} · auto off`;
                }

                const target = contextWindow - compaction.reserveTokens;
                if (target <= 0) return "no headroom";
                if (contextTokens == null) return `?/${compactNumber(target)}`;

                const percent = (contextTokens / target) * 100;
                return `${compactNumber(contextTokens)}/${compactNumber(target)} (${theme.fg(usageColor(percent), `${Math.round(percent)}%`)})`;
              }
              case "git-branch": return branch ?? "not in git";
              case "git-changes": return gitStatus;
              case "thinking-effort": return ctx.thinkingLevel ?? "unknown";
              case "compaction-counter": return `${compactions}`;
              case "min-request-cost": return ctx.model ? minRequestCost(ctx.model, contextTokens) : "?";
              case "session-clock": return elapsed(sessionSeconds);
              case "session-cost": return `$${cost.toFixed(3)}`;
              case "session-name": return ctx.sessionManager.getSessionName() ?? "";
              default: return "";
            }
          }

          return LINES.map((line) => {
            const items = line
              .map((segment) => ({ segment, value: valueFor(segment.type) }))
              .filter(({ value }) => value !== "")
              .map(({ segment, value }) =>
                `${theme.fg("dim", `${segment.label}: `)}${theme.fg(themeColor(segment.color), value)}`,
              );
            return truncateToWidth(items.join(theme.fg("dim", "  •  ")), width);
          });
        },
      };
    });

    update(ctx);
  });

  pi.on("input", (_event, ctx) => update(ctx));
  pi.on("message_end", (_event, ctx) => update(ctx));
  pi.on("turn_start", (_event, ctx) => update(ctx));
  pi.on("turn_end", (_event, ctx) => update(ctx));
  pi.on("agent_settled", (_event, ctx) => update(ctx));
  pi.on("tool_execution_end", (_event, ctx) => update(ctx));
  pi.on("model_select", (_event, ctx) => update(ctx));
  pi.on("thinking_level_select", (_event, ctx) => update(ctx));
  pi.on("session_info_changed", (_event, ctx) => update(ctx));
  pi.on("session_compact", (_event, ctx) => update(ctx));
  pi.on("session_tree", (_event, ctx) => update(ctx));
}
