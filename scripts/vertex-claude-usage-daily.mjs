#!/usr/bin/env node
/**
 * Vertex-Claude JSONL usage aggregation (dependency-free).
 *
 * Reads repo-local logs by default:
 *   ./claude-config/.claude/projects/   (recursive; all .jsonl files)
 *
 * Handles Claude Code / Vertex log shapes like:
 * - assistant lines:
 *     timestamp (top-level string)
 *     message.model (string)
 *     requestId (string)
 *     message.id (string)
 *     message.usage.{input_tokens, output_tokens, cache_creation_input_tokens, cache_read_input_tokens}
 *
 * Dedupes repeated assistant message variants that share the same:
 *   (requestId/sessionId, message.id/uuid, usage tuple)
 *
 * Outputs per day, per model:
 *   input, output, cache_create, cache_read, total_tokens, cost_usd
 *
 * Output modes:
 *   OUTPUT=table (default), json, tsv
 *
 * Env:
 *   CLAUDE_PROJECTS_DIR=./claude-config/.claude/projects:/other/root
 *   PRICES_FILE=./scripts/vertex-claude-prices.json
 *   OUTPUT=table|json|tsv
 *   DEBUG=1
 */

import fs from "node:fs";
import path from "node:path";
import readline from "node:readline";

const DEBUG = process.env.DEBUG === "1";

function defaultRoots() {
  return [path.resolve("claude-config/.claude/projects")];
}

function parseRootsFromEnv() {
  const v = process.env.CLAUDE_PROJECTS_DIR;
  if (!v) return null;
  return v
    .split(":")
    .map((s) => s.trim())
    .filter(Boolean)
    .map((p) => path.resolve(p));
}

function existsDir(p) {
  try {
    return fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
}

async function* walkFiles(dir) {
  const entries = await fs.promises.readdir(dir, { withFileTypes: true });
  for (const ent of entries) {
    const p = path.join(dir, ent.name);
    if (ent.isDirectory()) yield* walkFiles(p);
    else if (ent.isFile() && ent.name.endsWith(".jsonl")) yield p;
  }
}

async function readJsonl(filePath, onLineObj) {
  const stream = fs.createReadStream(filePath, { encoding: "utf8" });
  const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });
  for await (const line of rl) {
    const s = line.trim();
    if (!s) continue;
    let obj;
    try {
      obj = JSON.parse(s);
    } catch {
      if (DEBUG) process.stderr.write(`DEBUG: bad json in ${filePath}\n`);
      continue;
    }
    onLineObj(obj);
  }
}

function toNum(x) {
  if (typeof x === "number" && Number.isFinite(x)) return x;
  if (typeof x === "string") {
    const n = Number(x);
    if (Number.isFinite(n)) return n;
  }
  return 0;
}

function dayKeyFromTimestamp(ts, timeZone) {
  const d = new Date(ts);
  if (Number.isNaN(d.getTime())) return null;
  const fmt = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });
  return fmt.format(d); // YYYY-MM-DD
}

function normalizeModelName(m) {
  return (m && String(m).trim()) || "unknown";
}

/**
 * Extract an assistant usage event from your log line.
 * Returns {timestamp, model, input, output, cache_create, cache_read, dedupeKey} or null.
 */
function extractUsageEvent(lineObj) {
  const msg = lineObj?.message;
  const usage = msg?.usage;

  if (!usage || typeof usage !== "object") return null;

  const ts = lineObj?.timestamp;
  if (typeof ts !== "string") {
    if (DEBUG)
      process.stderr.write(
        `DEBUG: usage line missing top-level timestamp, uuid=${lineObj?.uuid ?? "?"}\n`,
      );
    return null;
  }

  const model = msg?.model;
  if (typeof model !== "string") {
    if (DEBUG)
      process.stderr.write(`DEBUG: usage line missing message.model, uuid=${lineObj?.uuid ?? "?"}\n`);
    return null;
  }

  const input = toNum(usage.input_tokens ?? usage.prompt_tokens);
  const output = toNum(usage.output_tokens ?? usage.completion_tokens);
  const cache_create = toNum(usage.cache_creation_input_tokens ?? usage.cache_create_input_tokens);
  const cache_read = toNum(usage.cache_read_input_tokens ?? usage.cache_read_tokens);

  if (input === 0 && output === 0 && cache_create === 0 && cache_read === 0) return null;

  // Claude Code logs often repeat the same assistant message id + requestId across
  // thinking/text/tool_use frames with identical usage. Count it once.
  const requestish =
    (typeof lineObj?.requestId === "string" && lineObj.requestId) ||
    (typeof lineObj?.sessionId === "string" && lineObj.sessionId) ||
    "";

  const msgId =
    (typeof msg?.id === "string" && msg.id) ||
    (typeof lineObj?.uuid === "string" && lineObj.uuid) ||
    "";

  // Don't include timestamp (repeats have different timestamps); include usage tuple instead.
  const dedupeKey = [requestish, msgId, model, input, output, cache_create, cache_read].join("|");

  return {
    timestamp: ts,
    model: normalizeModelName(model),
    input,
    output,
    cache_create,
    cache_read,
    dedupeKey,
  };
}

/**
 * Pricing file format:
 * {
 *   "default": { "tiers": [ { min/max..., input_per_1m, output_per_1m, cache_create_per_1m, cache_read_per_1m } ] },
 *   "<model>": { "tiers": [ ... ] }
 * }
 */
function loadPrices(pricesPath) {
  try {
    const raw = fs.readFileSync(pricesPath, "utf8");
    const obj = JSON.parse(raw);
    if (!obj || typeof obj !== "object") return null;
    return obj;
  } catch {
    return null;
  }
}

function pickTier(modelPricing, inputTokens) {
  const tiers = modelPricing?.tiers;
  if (!Array.isArray(tiers) || tiers.length === 0) return null;

  for (const t of tiers) {
    const minOk =
      t.min_input_tokens_inclusive == null || inputTokens >= Number(t.min_input_tokens_inclusive);
    const maxOk =
      t.max_input_tokens_exclusive == null || inputTokens < Number(t.max_input_tokens_exclusive);
    if (minOk && maxOk) return t;
  }
  return tiers[0];
}

function rate(tier, key) {
  const n = Number(tier?.[key]);
  return Number.isFinite(n) ? n : 0;
}

function costUSDForEvent(tokens, tier) {
  const per = 1_000_000;
  return (
    (tokens.input * rate(tier, "input_per_1m")) / per +
    (tokens.output * rate(tier, "output_per_1m")) / per +
    (tokens.cache_create * rate(tier, "cache_create_per_1m")) / per +
    (tokens.cache_read * rate(tier, "cache_read_per_1m")) / per
  );
}

function roundMoney(x) {
  return Math.round(x * 1e6) / 1e6;
}

function ensure(agg, day, model) {
  if (!agg[day]) agg[day] = {};
  if (!agg[day][model]) {
    agg[day][model] = {
      input: 0,
      output: 0,
      cache_create: 0,
      cache_read: 0,
      total_tokens: 0,
      cost_usd: 0,
    };
  }
  return agg[day][model];
}

function sortKeys(a, b) {
  return a < b ? -1 : a > b ? 1 : 0;
}

function printJSON(agg) {
  const days = Object.keys(agg).sort(sortKeys);
  const out = [];
  for (const day of days) {
    const models = Object.keys(agg[day]).sort(sortKeys);
    for (const model of models) {
      const r = agg[day][model];
      out.push({
        date: day,
        model,
        input: r.input,
        output: r.output,
        cache_create: r.cache_create,
        cache_read: r.cache_read,
        total_tokens: r.total_tokens,
        cost_usd: roundMoney(r.cost_usd),
      });
    }
  }
  process.stdout.write(JSON.stringify(out, null, 2) + "\n");
}

function printTSV(agg) {
  process.stdout.write(
    "date\tmodel\tinput\toutput\tcache_create\tcache_read\ttotal_tokens\tcost_usd\n",
  );
  const days = Object.keys(agg).sort(sortKeys);
  for (const day of days) {
    const models = Object.keys(agg[day]).sort(sortKeys);
    for (const model of models) {
      const r = agg[day][model];
      process.stdout.write(
        `${day}\t${model}\t${r.input}\t${r.output}\t${r.cache_create}\t${r.cache_read}\t${r.total_tokens}\t${roundMoney(
          r.cost_usd,
        )}\n`,
      );
    }
  }
}

function printTable(agg) {
  const rows = [];
  const days = Object.keys(agg).sort(sortKeys);

  const totals = {
    input: 0,
    output: 0,
    cache_create: 0,
    cache_read: 0,
    total_tokens: 0,
    cost_usd: 0,
  };

  for (const day of days) {
    for (const model of Object.keys(agg[day]).sort(sortKeys)) {
      const r = agg[day][model];
      rows.push({
        date: day,
        model,
        input: r.input,
        output: r.output,
        cache_create: r.cache_create,
        cache_read: r.cache_read,
        total_tokens: r.total_tokens,
        cost_usd: r.cost_usd,
      });

      totals.input += r.input;
      totals.output += r.output;
      totals.cache_create += r.cache_create;
      totals.cache_read += r.cache_read;
      totals.total_tokens += r.total_tokens;
      totals.cost_usd += r.cost_usd;
    }
  }

  const fmt = (n) => n.toLocaleString("en-US");
  const money = (n) => `$${roundMoney(n).toFixed(4)}`;

  const header =
    "Date       | Model                          | Input  | Output | Cache Create | Cache Read | Total Tokens | Cost USD";
  const sep =
    "-----------|--------------------------------|--------|--------|--------------|------------|--------------|---------";

  console.log("\nClaude Code Token Usage – Daily\n");
  console.log(header);
  console.log(sep);

  for (const r of rows) {
    console.log(
      `${r.date.padEnd(10)} | ${r.model.padEnd(30)} | ${fmt(r.input).padStart(6)} | ${fmt(
        r.output,
      ).padStart(6)} | ${fmt(r.cache_create).padStart(12)} | ${fmt(r.cache_read).padStart(
        10,
      )} | ${fmt(r.total_tokens).padStart(12)} | ${money(r.cost_usd).padStart(7)}`,
    );
  }

  console.log(sep);
  console.log(
    `${"TOTAL".padEnd(10)} | ${"all models".padEnd(30)} | ${fmt(totals.input).padStart(
      6,
    )} | ${fmt(totals.output).padStart(6)} | ${fmt(totals.cache_create).padStart(
      12,
    )} | ${fmt(totals.cache_read).padStart(10)} | ${fmt(totals.total_tokens).padStart(
      12,
    )} | ${money(totals.cost_usd).padStart(7)}`,
  );
}

const pricedModels = new Set();
const unpricedModels = new Set();

async function main() {
  const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const outputFmt = (process.env.OUTPUT || "table").toLowerCase();
  const pricesPath = process.env.PRICES_FILE || path.resolve("scripts/vertex-claude-prices.json");

  const roots = (parseRootsFromEnv() || defaultRoots()).filter(existsDir);
  if (roots.length === 0) {
    console.error(
      "No Claude projects directories found.\n" +
        "Checked:\n" +
        defaultRoots()
          .map((p) => `  - ${p}`)
          .join("\n"),
    );
    process.exit(1);
  }

  const prices = loadPrices(pricesPath);
  if (!prices) {
    process.stderr.write(
      `WARN: Could not read prices file at "${pricesPath}". Cost will be 0.\n`,
    );
  }

  const agg = {};
  const seen = new Set();
  let counted = 0;
  let skippedDupes = 0;

  for (const root of roots) {
    for await (const file of walkFiles(root)) {
      await readJsonl(file, (lineObj) => {
        const ev = extractUsageEvent(lineObj);
        if (!ev) return;

        if (seen.has(ev.dedupeKey)) {
          skippedDupes += 1;
          return;
        }
        seen.add(ev.dedupeKey);

        const day = dayKeyFromTimestamp(ev.timestamp, timeZone);
        if (!day) return;

        const total_tokens = ev.input + ev.output + ev.cache_create + ev.cache_read;

        let cost = 0;
        let priced = false;

        if (prices) {
          const modelPricing = prices[ev.model] || prices.default || null;
          const tier = pickTier(modelPricing, ev.input);
          if (tier) {
            cost = costUSDForEvent(
              {
                input: ev.input,
                output: ev.output,
                cache_create: ev.cache_create,
                cache_read: ev.cache_read,
              },
              tier,
            );
            priced = true;
          }
        }

        if (priced) pricedModels.add(ev.model);
        else unpricedModels.add(ev.model);

        const slot = ensure(agg, day, ev.model);
        slot.input += ev.input;
        slot.output += ev.output;
        slot.cache_create += ev.cache_create;
        slot.cache_read += ev.cache_read;
        slot.total_tokens += total_tokens;
        slot.cost_usd += cost;

        counted += 1;
      });
    }
  }

  if (DEBUG) {
    process.stderr.write(`DEBUG: counted=${counted}, skippedDupes=${skippedDupes}\n`);
  }

  if (unpricedModels.size > 0) {
  // If a model appears in both sets due to some events priced via default and some not,
  // keep it "priced" and remove from unpriced.
  for (const m of pricedModels) unpricedModels.delete(m);

  if (unpricedModels.size > 0) {
    console.error(
      `\nERROR: Missing pricing for ${unpricedModels.size} model(s). ` +
        `Costs for these models are shown as $0.0000:\n` +
        Array.from(unpricedModels)
          .sort()
          .map((m) => `  - ${m}`)
          .join("\n") +
        `\n\nFix: add model keys to scripts/claude-prices.json (or add a "default" tier).\n`,
    );
  }
}

  if (outputFmt === "tsv") printTSV(agg);
  else if (outputFmt === "json") printJSON(agg);
  else printTable(agg);
}

main().catch((err) => {
  console.error(err?.stack || String(err));
  process.exit(1);
});