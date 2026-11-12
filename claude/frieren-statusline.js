#!/usr/bin/env node
// Frieren-themed status line for Claude Code (theme colors). One line per section, label on the left:
//   sessão    model, effort, session name, the logged-in account's email (~/.claude.json)
//   local     repo, branch (always shown), worktree
//   contexto  context zone (smart / atenção / dumb) measured against the auto-compact window
//   limites   5-hour, 7-day and spend plan limits, plus per-model weekly limits other than Fable
//   jornada   session time, tokens used in the session, lines changed, cost (only without plan limits)
//   fable     Fable tokens in this session and Fable's weekly limit
// Zone limits come from ~/.claude/context-zones.json. The auto-compact window comes from
// CLAUDE_CODE_AUTO_COMPACT_WINDOW, modelSettings.<model>.autoCompactWindow or autoCompactWindow
// in ~/.claude/settings.json (same precedence as Claude Code), else the model's full window.
// Session tokens are summed from the transcript (plus subagent transcripts), read incrementally
// and cached in ~/.claude/state/statusline-tokens/<session_id>.json.
// Per-model weekly limits (Fable) are not in the status line payload. A detached copy of this
// script (`--fetch-usage`) reads them from /api/oauth/usage, the endpoint /usage uses, at most
// every 2 minutes, and caches them in ~/.claude/state/statusline-usage.json. The status line only
// reads that cache. The endpoint is internal: if it changes, the weekly Fable figure disappears.
// Inside Orca (ORCA_PANE_KEY is set) the payload is also passed to Orca's own status line
// command, so Orca's usage view keeps working.

const fs = require("fs");
const path = require("path");
const { spawn, spawnSync } = require("child_process");

const HOME = process.env.USERPROFILE || process.env.HOME || "";
const CLAUDE_DIR = path.join(HOME, ".claude");
const ORCA_STATUSLINE = path.join(HOME, ".orca", "agent-hooks", "claude-statusline.cmd");
const ZONES_FILE = path.join(CLAUDE_DIR, "context-zones.json");
const SETTINGS_FILE = path.join(CLAUDE_DIR, "settings.json");
const ACCOUNT_FILE = path.join(HOME, ".claude.json");
const CREDENTIALS_FILE = path.join(CLAUDE_DIR, ".credentials.json");
const STATE_DIR = path.join(CLAUDE_DIR, "state");
const TOKENS_DIR = path.join(STATE_DIR, "statusline-tokens");
const USAGE_FILE = path.join(STATE_DIR, "statusline-usage.json");
const USAGE_LOCK = `${USAGE_FILE}.lock`;
const USAGE_URL = "https://api.anthropic.com/api/oauth/usage";
const DEFAULT_ZONES = { smartUntil: 120000, dumbFrom: 180000 };
const TOKEN_CACHE_VERSION = 2;
const TOKEN_CACHE_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
const USAGE_REFRESH_MS = 2 * 60 * 1000;
const USAGE_RETRY_MS = 10 * 60 * 1000;
const USAGE_TOKEN_RETRY_MS = 60 * 1000;
const USAGE_STALE_MS = 15 * 60 * 1000;
const USAGE_LOCK_MS = 30 * 1000;
const LABEL_WIDTH = 10;

// ---- colors ----
const hex = (h) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16));
const fg = (h) => `\x1b[38;2;${hex(h).join(";")}m`;
const RESET = "\x1b[0m";
const paint = (h, text) => `${fg(h)}${text}${RESET}`;

const C = {
  text: "#e4eaf3",
  muted: "#b5b8bd",
  dim: "#7f8794",
  accent: "#91b6ee",
  gold: "#e5c07b",
  green: "#89c5aa",
  red: "#e58c9a",
  hot: "#f0705f",
  violet: "#b9a0e2",
  teal: "#85c4d0",
};
// Darker tint of each zone color, for the empty part of the context bar.
const TRACK = { [C.green]: "#3d5a4d", [C.gold]: "#5e5236", [C.hot]: "#5e3530" };

// ---- generic helpers ----
function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}

function writeAtomic(file, text) {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, text);
    fs.renameSync(tmp, file);
  } catch {}
}

// Reads a token count written as 200000, "200000", "200k" or "1M".
function tokenCount(value) {
  if (typeof value === "number") return value > 0 ? value : null;
  if (typeof value !== "string") return null;
  const m = value.trim().match(/^(\d+(?:\.\d+)?)\s*([kKmM]?)$/);
  if (!m) return null;
  const unit = m[2].toLowerCase();
  const n = parseFloat(m[1]) * (unit === "k" ? 1e3 : unit === "m" ? 1e6 : 1);
  return n > 0 ? n : null;
}

function fmt(n) {
  if (n == null) return "—";
  if (n < 1000) return String(Math.round(n));
  if (n < 1e6) return `${(n / 1e3).toFixed(n < 1e4 ? 1 : 0)}k`;
  if (n < 1e9) return `${(n / 1e6).toFixed(n < 1e7 ? 2 : 1)}M`;
  return `${(n / 1e9).toFixed(2)}B`;
}

function clock(epochSeconds) {
  const d = new Date(epochSeconds * 1000);
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

function weekday(epochSeconds) {
  return ["dom", "seg", "ter", "qua", "qui", "sex", "sáb"][new Date(epochSeconds * 1000).getDay()];
}

// Epoch seconds from a number (seconds) or an ISO date string.
function toEpochSeconds(value) {
  if (typeof value === "number") return value;
  if (typeof value !== "string") return null;
  const ms = Date.parse(value);
  return Number.isNaN(ms) ? null : Math.floor(ms / 1000);
}

function duration(ms) {
  const m = Math.floor((ms || 0) / 60000);
  if (m < 1) return "<1m";
  if (m < 60) return `${m}m`;
  return `${Math.floor(m / 60)}h${String(m % 60).padStart(2, "0")}m`;
}

function level(pct, warn, bad) {
  return pct >= bad ? C.hot : pct >= warn ? C.gold : C.green;
}

const sum = (v) => v.reduce((a, b) => a + b, 0);

// ---- git ----
function git(dir) {
  // Finds .git upward and reads HEAD directly (no git process: the line redraws every second).
  for (let d = dir; d; ) {
    const dotgit = path.join(d, ".git");
    try {
      const st = fs.statSync(dotgit);
      let gitdir = dotgit;
      if (st.isFile()) {
        const m = fs.readFileSync(dotgit, "utf8").match(/gitdir:\s*(.+)/);
        if (!m) return null;
        gitdir = path.resolve(d, m[1].trim());
      }
      const head = fs.readFileSync(path.join(gitdir, "HEAD"), "utf8").trim();
      const ref = head.match(/^ref: refs\/heads\/(.+)$/);
      return { root: d, branch: ref ? ref[1] : head.slice(0, 7) };
    } catch {}
    const up = path.dirname(d);
    if (up === d) break;
    d = up;
  }
  return null;
}

// ---- context zones ----
function zones() {
  const cfg = readJson(ZONES_FILE) || {};
  const smartUntil = tokenCount(cfg.smartUntil) ?? DEFAULT_ZONES.smartUntil;
  const dumbFrom = tokenCount(cfg.dumbFrom) ?? DEFAULT_ZONES.dumbFrom;
  return { smartUntil, dumbFrom: Math.max(dumbFrom, smartUntil) };
}

// The context size at which Claude Code compacts on its own.
function compactWindow(s) {
  const full = s.context_window?.context_window_size || 200000;
  const settings = readJson(SETTINGS_FILE) || {};
  const modelId = (s.model?.id || "").replace(/\[1m\]$/i, "");
  const perModel = settings.modelSettings?.[modelId]?.autoCompactWindow;
  let w = tokenCount(process.env.CLAUDE_CODE_AUTO_COMPACT_WINDOW);
  if (w == null && perModel !== "auto") w = tokenCount(perModel) ?? tokenCount(settings.autoCompactWindow);
  if (w == null) return full;
  return Math.min(full, Math.max(100000, Math.min(1000000, w)));
}

function zoneColor(tokens, z) {
  return tokens < z.smartUntil ? C.green : tokens < z.dumbFrom ? C.gold : C.hot;
}

// Bar over the auto-compact window, each cell tinted by the zone it falls in.
function zoneBar(ctx, limit, z, width = 20) {
  let out = "";
  for (let i = 0; i < width; i++) {
    const at = ((i + 0.5) / width) * limit;
    const color = zoneColor(at, z);
    out += ctx != null && at <= ctx ? paint(color, "━") : paint(TRACK[color], "─");
  }
  return out;
}

// ---- session tokens ----
// totals and fable are [input, cache write, cache read, output]; fable counts only Fable replies.
const freshEntry = () => ({ offset: 0, totals: [0, 0, 0, 0], fable: [0, 0, 0, 0], recent: [] });

// Returns the complete lines appended to `file` since entry.offset and moves the offset.
function readNewLines(file, entry) {
  let fd;
  try {
    fd = fs.openSync(file, "r");
    const size = fs.fstatSync(fd).size;
    if (size < entry.offset) Object.assign(entry, freshEntry()); // file rewritten: count again
    if (size === entry.offset) return [];
    const buf = Buffer.alloc(size - entry.offset);
    fs.readSync(fd, buf, 0, buf.length, entry.offset);
    const end = buf.lastIndexOf(10);
    if (end < 0) return [];
    entry.offset += end + 1;
    return buf.subarray(0, end).toString("utf8").split("\n");
  } catch {
    return [];
  } finally {
    if (fd !== undefined) {
      try {
        fs.closeSync(fd);
      } catch {}
    }
  }
}

function addTo(bucket, v, sign = 1) {
  for (let i = 0; i < 4; i++) bucket[i] += sign * v[i];
}

// One API response can span several transcript lines with the same message id; count it once.
function addUsage(entry, line) {
  if (!line.includes('"usage"')) return;
  let o;
  try {
    o = JSON.parse(line);
  } catch {
    return;
  }
  const u = o?.message?.usage;
  if (o.type !== "assistant" || !u) return;
  const v = [u.input_tokens || 0, u.cache_creation_input_tokens || 0, u.cache_read_input_tokens || 0, u.output_tokens || 0];
  const isFable = /^claude-fable/i.test(o.message.model || "");
  const id = o.message.id || o.uuid;
  const prev = entry.recent.find((r) => r[0] === id);
  if (prev) {
    addTo(entry.totals, prev[1], -1);
    if (prev[2]) addTo(entry.fable, prev[1], -1);
    prev[1] = v;
    prev[2] = isFable;
  } else {
    entry.recent.push([id, v, isFable]);
    if (entry.recent.length > 30) entry.recent.shift();
  }
  addTo(entry.totals, v);
  if (isFable) addTo(entry.fable, v);
}

function pruneTokenCache() {
  try {
    const now = Date.now();
    for (const f of fs.readdirSync(TOKENS_DIR)) {
      const p = path.join(TOKENS_DIR, f);
      if (now - fs.statSync(p).mtimeMs > TOKEN_CACHE_MAX_AGE_MS) fs.unlinkSync(p);
    }
  } catch {}
}

// Totals for the main chat, for subagents, and for Fable replies in either.
function sessionTokens(s) {
  const main = s.transcript_path;
  if (!main || !s.session_id) return null;
  const cacheFile = path.join(TOKENS_DIR, `${s.session_id}.json`);
  let cache = readJson(cacheFile);
  if (!cache || cache.v !== TOKEN_CACHE_VERSION || typeof cache.files !== "object") {
    cache = { v: TOKEN_CACHE_VERSION, files: {} };
    pruneTokenCache();
  }
  const files = [main];
  const subDir = path.join(path.dirname(main), path.basename(main, ".jsonl"), "subagents");
  try {
    for (const f of fs.readdirSync(subDir)) if (f.endsWith(".jsonl")) files.push(path.join(subDir, f));
  } catch {}
  const result = { main: [0, 0, 0, 0], agents: [0, 0, 0, 0], fable: [0, 0, 0, 0] };
  let changed = false;
  for (const f of files) {
    const entry = cache.files[f] || (cache.files[f] = freshEntry());
    const before = entry.offset;
    for (const line of readNewLines(f, entry)) addUsage(entry, line);
    if (entry.offset !== before) changed = true;
    addTo(f === main ? result.main : result.agents, entry.totals);
    addTo(result.fable, entry.fable);
  }
  if (changed) writeAtomic(cacheFile, JSON.stringify(cache));
  return result;
}

// ---- per-model weekly limits (/api/oauth/usage) ----
// The weekly windows scoped to one model, as [{ name, pct, resetsAt }].
function scopedLimits(body) {
  const limits = Array.isArray(body?.limits) ? body.limits : [];
  return limits
    .filter((l) => l?.kind === "weekly_scoped" && l.scope?.model?.display_name && typeof l.percent === "number")
    .map((l) => ({ name: l.scope.model.display_name, pct: l.percent, resetsAt: toEpochSeconds(l.resets_at) }));
}

// `--fetch-usage` mode: one request, then the cache is written and the lock removed.
async function fetchUsage() {
  const prev = readJson(USAGE_FILE) || {};
  const out = { fetchedAt: prev.fetchedAt || 0, limits: Array.isArray(prev.limits) ? prev.limits : [] };
  try {
    const oauth = readJson(CREDENTIALS_FILE)?.claudeAiOauth;
    if (!oauth?.accessToken || (oauth.expiresAt && oauth.expiresAt < Date.now())) {
      // Claude Code refreshes the token on its own; try again soon.
      out.error = "token unavailable or expired";
      out.retryAt = Date.now() + USAGE_TOKEN_RETRY_MS;
    } else {
      const res = await fetch(USAGE_URL, {
        headers: { Authorization: `Bearer ${oauth.accessToken}`, "anthropic-beta": "oauth-2025-04-20", "Content-Type": "application/json" },
        signal: AbortSignal.timeout(5000),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      out.limits = scopedLimits(await res.json());
      out.fetchedAt = Date.now();
    }
  } catch (e) {
    out.error = String(e?.message || e).slice(0, 80);
    out.retryAt = Date.now() + USAGE_RETRY_MS;
  }
  writeAtomic(USAGE_FILE, JSON.stringify(out));
  try {
    fs.unlinkSync(USAGE_LOCK);
  } catch {}
}

// Takes the lock without racing other sessions' status lines; a lock older than 30 s is dead.
function takeUsageLock() {
  try {
    if (Date.now() - fs.statSync(USAGE_LOCK).mtimeMs < USAGE_LOCK_MS) return false;
    fs.unlinkSync(USAGE_LOCK);
  } catch {}
  try {
    fs.mkdirSync(STATE_DIR, { recursive: true });
    fs.closeSync(fs.openSync(USAGE_LOCK, "wx"));
    return true;
  } catch {
    return false;
  }
}

// Starts a detached fetch when the cache is old; never waits for it.
function refreshUsage(cache) {
  const now = Date.now();
  if (cache?.retryAt && now < cache.retryAt) return;
  if (cache && now - (cache.fetchedAt || 0) < USAGE_REFRESH_MS) return;
  if (!fs.existsSync(CREDENTIALS_FILE) || !takeUsageLock()) return;
  try {
    spawn(process.execPath, [__filename, "--fetch-usage"], { detached: true, stdio: "ignore", windowsHide: true }).unref();
  } catch {
    try {
      fs.unlinkSync(USAGE_LOCK);
    } catch {}
  }
}

// ---- status line ----
const sep = paint(C.dim, " · ");
const row = (label, parts) => paint(C.dim, label.padEnd(LABEL_WIDTH)) + parts.join(sep);

function limitText(name, pct, resetsAt, withDay, stale) {
  const p = Math.round(pct);
  const reset = resetsAt ? ` ↻${withDay ? `${weekday(resetsAt)} ` : ""}${clock(resetsAt)}` : "";
  if (stale) return paint(C.dim, `${name} ~${p}%${reset}`);
  return paint(C.muted, `${name} `) + paint(level(p, 70, 90), `${p}%`) + paint(C.muted, reset);
}

function render(s, usage) {
  const lines = [];

  // sessão: who
  const model = s.model?.display_name || s.model?.id || "Claude";
  const who = [paint(C.text, model)];
  if (s.effort?.level) who.push(paint(C.violet, s.effort.level));
  if (s.session_name) who.push(paint(C.teal, `“${s.session_name}”`));
  const email = readJson(ACCOUNT_FILE)?.oauthAccount?.emailAddress;
  if (email) who.push(paint(C.muted, email));
  lines.push(row("sessão", who));

  // local: where
  const dir = s.workspace?.current_dir || s.cwd || process.cwd();
  const repo = git(dir);
  const place = s.workspace?.repo?.name || path.basename(repo?.root || dir) || dir;
  const where = [paint(C.text, place), repo?.branch ? paint(C.green, repo.branch) : paint(C.dim, "sem git")];
  if (s.workspace?.git_worktree) where.push(paint(C.muted, s.workspace.git_worktree));
  lines.push(row("local", where));

  // contexto: zone over the auto-compact window
  const cw = s.context_window || {};
  const ctx = cw.current_usage || cw.total_input_tokens > 0 ? cw.total_input_tokens || 0 : null;
  const z = zones();
  const limit = compactWindow(s);
  const ctxText = ctx == null ? paint(C.dim, "—") : paint(zoneColor(ctx, z), fmt(ctx));
  const context = [zoneBar(ctx, limit, z) + " " + ctxText + paint(C.dim, `/${fmt(limit)}`)];
  if (ctx == null) context.push(paint(C.dim, "aguardando resposta"));
  else if (ctx < z.smartUntil) context.push(paint(C.green, "zona smart"));
  else if (ctx < z.dumbFrom) context.push(paint(C.gold, "atenção") + paint(C.muted, ` · dumb em ${fmt(z.dumbFrom - ctx)}`));
  else context.push(paint(C.hot, "zona dumb") + paint(C.muted, " · /compact ou /clear"));
  lines.push(row("contexto", context));

  // limites: plan limits
  const stale = !usage?.fetchedAt || Date.now() - usage.fetchedAt > USAGE_STALE_MS;
  const scoped = (Array.isArray(usage?.limits) ? usage.limits : []).filter((l) => typeof l?.pct === "number" && l.name);
  const fableLimit = scoped.find((l) => /fable/i.test(l.name));
  const limits = [];
  const rl = s.rate_limits || {};
  if (typeof rl.five_hour?.used_percentage === "number") limits.push(limitText("5h", rl.five_hour.used_percentage, rl.five_hour.resets_at, false));
  if (typeof rl.seven_day?.used_percentage === "number") limits.push(limitText("semana", rl.seven_day.used_percentage, rl.seven_day.resets_at, true));
  if (typeof rl.spend_limit?.used_percentage === "number") limits.push(limitText("gasto", rl.spend_limit.used_percentage, null, false));
  for (const l of scoped) if (l !== fableLimit) limits.push(limitText(l.name, l.pct, l.resetsAt, true, stale));
  if (limits.length) lines.push(row("limites", limits));

  // jornada: the session so far
  const journey = [paint(C.text, duration(s.cost?.total_duration_ms))];
  const tk = sessionTokens(s);
  let sessionTotal = 0;
  if (tk) {
    const all = [0, 1, 2, 3].map((i) => tk.main[i] + tk.agents[i]);
    const input = all[0] + all[1] + all[2];
    sessionTotal = input + all[3];
    const details = [];
    if (input > 0) details.push(`cache ${Math.round((all[2] / input) * 100)}%`);
    details.push(`saída ${fmt(all[3])}`);
    const agents = sum(tk.agents);
    if (agents > 0) details.push(`agentes ${fmt(agents)}`);
    journey.push(paint(C.muted, "tokens ") + paint(C.text, fmt(sessionTotal)) + paint(C.dim, ` (${details.join(" · ")})`));
  }
  const added = s.cost?.total_lines_added || 0;
  const removed = s.cost?.total_lines_removed || 0;
  if (added || removed) journey.push(paint(C.green, `+${added}`) + " " + paint(C.red, `−${removed}`));
  if (!s.rate_limits && typeof s.cost?.total_cost_usd === "number") journey.push(paint(C.gold, `US$ ${s.cost.total_cost_usd.toFixed(2)}`));
  lines.push(row("jornada", journey));

  // fable: this session's Fable tokens and Fable's weekly limit
  const fableTokens = tk ? sum(tk.fable) : 0;
  const fable = [];
  if (fableTokens > 0) {
    const share = sessionTotal > 0 ? paint(C.dim, ` (${Math.round((fableTokens / sessionTotal) * 100)}% da sessão)`) : "";
    fable.push(paint(C.muted, "sessão ") + paint(C.violet, `${fmt(fableTokens)} tokens`) + share);
  }
  if (fableLimit) fable.push(limitText("semana", fableLimit.pct, fableLimit.resetsAt, true, stale));
  if (fable.length) lines.push(row("fable", fable));

  return lines.join("\n") + RESET;
}

function main() {
  let raw = "";
  try {
    raw = fs.readFileSync(0, "utf8");
  } catch {}
  let s = {};
  try {
    s = JSON.parse(raw || "{}");
  } catch {}

  const usage = readJson(USAGE_FILE);
  process.stdout.write(render(s, usage));
  refreshUsage(usage);

  // Keep Orca's usage view fed when this runs inside an Orca pane.
  if (process.env.ORCA_PANE_KEY && raw && fs.existsSync(ORCA_STATUSLINE)) {
    try {
      spawnSync("cmd.exe", ["/d", "/c", ORCA_STATUSLINE], { input: raw, timeout: 4000, windowsHide: true, stdio: ["pipe", "ignore", "ignore"] });
    } catch {}
  }
}

if (process.argv.includes("--fetch-usage")) fetchUsage();
else main();
