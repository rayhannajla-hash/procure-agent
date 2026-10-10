// The purchasing agent: a Gemini tool-use loop over three workflow tools. The model searches, compares and
// proposes; policy.mjs decides; PayPal only moves money after a person approves the order in PayPal.
import { GoogleGenAI, ApiError } from "@google/genai";
import { searchCatalog } from "./channel3.mjs";
import { evaluate, isApprovedRetailer, policySummary } from "./policy.mjs";
import { createOrder } from "./paypal.mjs";
import { addRequisition, updateRequisition, policy } from "./store.mjs";

// Tried in order; a model that is unavailable or out of free quota falls through to the next.
const GEMINI_MODELS = (process.env.GEMINI_MODEL || "gemini-3.8-flash,gemini-3.5-flash,gemini-3.5-flash-lite")
  .split(",").map((m) => m.trim()).filter(Boolean);
const MAX_TURNS = 14;
// Words that make a quoted sentence an actual reason to buy again (English and Indonesian).
const REASON_WORDS = /\b(broke|broken|break|fail|failed|failure|faulty|damaged|defective|worn|lost|stolen|replace|replacement|replacing|additional|extra|spare|more|another|second|new hires?|new operators?|expan\w*|second shift|rusak|patah|hilang|ganti|pengganti|tambahan|tambah|cadangan|lagi)\b/;
const FINISH_NUDGE = "You have not finished. Do not ask the requester questions: use the information given, make reasonable assumptions and state them in the summary. Call submit_requisition if a compliant basket exists, otherwise decline_request.";

export const agentMode = process.env.GEMINI_API_KEY ? "gemini" : "scripted";
export const MODEL = agentMode === "gemini" ? GEMINI_MODELS[0] : null;

const TOOL_DEFS = [
  {
    name: "search_catalog",
    description: "Search live retail listings (Channel3, 100M+ products) for an item to buy. Use short English product terms with the key spec, e.g. 'temperature controlled soldering station 60W'. Only in-stock listings come back, and by default only from the company's approved retailers. Each result has a ref (P1, P2, ...) that the other tools use. The number of searches per request is limited.",
    parameters: {
      type: "object",
      properties: {
        query: { type: "string", description: "Product search terms." },
        max_unit_price: { type: "number", description: "Optional price ceiling per unit in USD." },
        limit: { type: "integer", description: "How many listings to return, 3-8. Default 6." },
        approved_only: { type: "boolean", description: "Default true. Set false only to show the requester what exists elsewhere when no approved retailer has a fitting item; those listings cannot be ordered." },
      },
      required: ["query"],
    },
  },
  {
    name: "check_policy",
    description: "Dry-run the company spend policy on a draft basket. Returns every rule with pass/fail, the order total, the remaining monthly budget and which approver the order would need. Nothing is ordered.",
    parameters: {
      type: "object",
      properties: {
        lines: {
          type: "array",
          items: {
            type: "object",
            properties: { ref: { type: "string" }, quantity: { type: "integer" } },
            required: ["ref", "quantity"],
          },
        },
      },
      required: ["lines"],
    },
  },
  {
    name: "submit_requisition",
    description: "Submit the final basket. The policy is re-checked in code; if every rule passes, a PayPal order is created and routed to the required approver, who must approve the payment in PayPal before any money moves. Call at most once.",
    parameters: {
      type: "object",
      properties: {
        requirements: {
          type: "array",
          description: "The must-have specs you derived from the request and its use, e.g. 'clear lens (indoor line work)', 'ANSI Z87.1 marked', '10 pairs total'.",
          items: { type: "string" },
        },
        lines: {
          type: "array",
          items: {
            type: "object",
            properties: {
              ref: { type: "string" },
              quantity: { type: "integer", description: "Number of listings to buy (packs, if the listing is a pack)." },
              units_covered: { type: "integer", description: "How many of the requested units this line delivers, e.g. 2 packs of 6 pairs = 12." },
              reason: { type: "string", description: "How this listing meets each requirement, quoting the title or features." },
            },
            required: ["ref", "quantity", "units_covered", "reason"],
          },
        },
        summary: { type: "string", description: "Two or three sentences for the approver: what is being bought, for what, and why this choice." },
        duplicate_justification: {
          type: "string",
          description: "Required when check_policy warned about a recent similar purchase: copy, word for word, the sentence of the request that says why another one is needed (e.g. a broken unit, more people). The server checks it appears in the request.",
        },
        compared: {
          type: "array",
          description: "The other listings you weighed and why each lost, so the approver can see the comparison.",
          items: {
            type: "object",
            properties: { ref: { type: "string" }, note: { type: "string" } },
            required: ["ref", "note"],
          },
        },
      },
      required: ["lines", "summary"],
    },
  },
  {
    name: "decline_request",
    description: "Stop without ordering when the request cannot be met within policy (over the order limit, over budget, restricted item, nothing suitable from an approved retailer). Explain what the requester can do instead.",
    parameters: {
      type: "object",
      properties: {
        reason: { type: "string" },
        next_step: { type: "string", description: "What the requester should do, e.g. raise an RFQ, ask the cost-center owner, change the spec." },
      },
      required: ["reason", "next_step"],
    },
  },
];

function systemPrompt(costCenter) {
  const p = policySummary();
  const cc = p.cost_centers.find((c) => c.id === costCenter);
  return `You are the purchasing agent for ${p.company}. Staff send you requests for maintenance, repair and operations (MRO) supplies: tools, ESD and safety gear, lab and workshop consumables. You turn a request into a policy-compliant purchase that a human approves in PayPal.

This request is charged to cost center ${costCenter} (${cc?.name ?? "unknown"}). You cannot change the cost center.

How to work:
1. Work out what is needed: item, quantity, budget hints, urgency, and the use. Then turn the use into must-have specs. This is a factory floor: an assembly line, an electronics rework bench, a QA lab, a warehouse. Examples: safety glasses for operators working indoors need clear lenses (tinted sunglasses are wrong indoors) and an ANSI Z87.1 mark; tools at an electronics bench should be ESD-safe; anything for a production line should be a work-grade product, not a toy, kid's, novelty, decorative or cosmetic item. Keep the requested quantity; never change it silently.
2. Search with focused queries that include the key specs (e.g. "ear muffs NRR 25"). You have at most ${policy.max_searches_per_request ?? 4} searches, so make each one count; searches already cover only approved retailers. Read each listing's title, features and description.
3. Rule out listings that contradict a must-have (wrong lens tint, wrong voltage, wrong size, not the item asked for), even if they are cheaper. A must-have counts as met only when the title, features or description show it; if no listing shows it, try different terms. If the approved retailers simply do not carry a fitting item, decline and say which kind of supplier Purchasing should add (you may run one search with approved_only=false to show what exists elsewhere).
4. Among the listings that meet every must-have, pick the best value: price, approved retailer, stock, rating. Cheapest is not automatically best if a slightly dearer listing fits clearly better.
5. Packs: when a listing is a pack (e.g. "Pack of 12", "5pcs", "box of 10", "2-pack"), the order quantity is the number of packs. Buy enough packs to cover the requested units with the least overshoot, and report units_covered. Never order 10 boxes of 12 when 10 pieces were asked for.
6. Run check_policy on the basket. If a rule fails, adapt (another listing, an approved retailer, a cheaper model that still meets every must-have) and check again. If it warns about a recent similar purchase by this cost center, go ahead only when the request itself says why another one is needed (more units, a different spec, a replacement for a broken one) and say so in the summary; otherwise decline as a likely duplicate and point to the earlier requisition or PO.
7. Before submitting, check each requirement against the chosen listing once more and list the requirements in submit_requisition.
- Finish with exactly one of: submit_requisition (everything passes), or decline_request (it cannot be bought within policy). When the order is too large or the budget is short, decline and point to the right next step instead of trimming the order.
- Use only refs that came back from search_catalog. Never invent products, prices, retailers or stock.

Policy in force (enforced in code, you cannot override it): one order at most $${p.hard_limit_per_order}; unit price at most $${p.max_unit_price}; 1-${p.max_quantity_per_line} units per line; in stock only; approved retailers only (${p.approved_retailers.join(", ")}); no restricted items (${p.blocked_keywords.join(", ")}). Approvers: ${p.approval_tiers.map((t) => `up to $${t.max_total} -> ${t.approver}`).join("; ")}.

Never claim the requester said, confirmed or approved anything that is not in their request; the approver relies on your summary being true.

There is no back-and-forth with the requester: never end your turn with a question. If a detail is missing, make a reasonable assumption for a factory setting and state it in the summary.

Write short, plain notes between tool calls, in the requester's language.`;
}

class Session {
  constructor(emit, request) {
    this.emit = emit;
    this.request = request;
    this.catalog = new Map(); // ref -> product
    this.seq = 0;
    this.searches = 0;
    this.result = null;
  }
  remember(product) {
    for (const [ref, p] of this.catalog) if (p.product_id === product.product_id && p.retailer === product.retailer) return ref;
    const ref = `P${++this.seq}`;
    this.catalog.set(ref, product);
    return ref;
  }
  resolve(lines) {
    const missing = lines.filter((l) => !this.catalog.has(l.ref)).map((l) => l.ref);
    if (missing.length) return { error: `Unknown refs: ${missing.join(", ")}. Use refs from search_catalog results.` };
    return {
      lines: lines.map((l) => ({
        ref: l.ref,
        product: this.catalog.get(l.ref),
        quantity: Number(l.quantity),
        units_covered: Number.isInteger(Number(l.units_covered)) ? Number(l.units_covered) : null,
        reason: l.reason,
      })),
    };
  }
}

async function runTool(s, name, input) {
  try {
    switch (name) {
      case "search_catalog": {
        const budget = policy.max_searches_per_request ?? 4;
        if (s.searches >= budget) {
          return { status: "error", error: `Search budget used (${budget} searches). Decide now with what you have: submit_requisition or decline_request.` };
        }
        s.searches += 1;
        const results = await searchCatalog({ query: input.query, maxUnitPrice: input.max_unit_price, limit: input.limit ?? 6, approvedOnly: input.approved_only !== false });
        const rows = results.map((p) => ({ ref: s.remember(p), ...p, approved_retailer: isApprovedRetailer(p.retailer) }));
        s.emit("results", { query: input.query, results: rows });
        return {
          results: rows.map(({ ref, title, brand, price, currency, retailer, approved_retailer, in_stock, rating, key_features, description }) =>
            ({ ref, title, brand, price, currency, retailer, approved_retailer, in_stock, rating, key_features, description })),
        };
      }
      case "check_policy": {
        const r = s.resolve(input.lines ?? []);
        if (r.error) return { status: "error", error: r.error };
        const verdict = evaluate({ costCenter: s.request.cost_center, lines: r.lines });
        s.emit("policy", { draft: true, ...verdict });
        return verdict;
      }
      case "submit_requisition": {
        if (s.result) return { status: "error", error: "A result was already recorded for this request." };
        const r = s.resolve(input.lines ?? []);
        if (r.error) return { status: "error", error: r.error };
        const verdict = evaluate({ costCenter: s.request.cost_center, lines: r.lines });
        s.emit("policy", { draft: false, ...verdict });
        if (verdict.verdict === "blocked") {
          return { status: "blocked", failed: verdict.checks.filter((c) => !c.pass), note: "Nothing was ordered. Adapt the basket or call decline_request." };
        }
        let justification = null;
        if (verdict.warnings.length) {
          // The reason must be the requester's own words and actually give a reason to buy again.
          const norm = (t) => String(t ?? "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
          const quote = norm(input.duplicate_justification);
          if (quote.length < 12 || !norm(s.request.text).includes(quote) || !REASON_WORDS.test(quote)) {
            return {
              status: "needs_justification",
              warnings: verdict.warnings,
              note: "Nothing was ordered. This cost center recently bought or requested a similar item. If the request itself says why another one is needed (broken, replacement, more people, extra line), resubmit with duplicate_justification copied word for word from that sentence. Otherwise call decline_request and point to the earlier requisition or PO.",
            };
          }
          justification = input.duplicate_justification.trim();
        }
        const lineRecords = r.lines.map(({ ref, product, quantity, units_covered, reason }) =>
          ({ ref, quantity, units_covered, reason, product, line_total: Math.round(product.price * quantity * 100) / 100 }));
        const compared = (input.compared ?? []).filter((c) => s.catalog.has(c.ref)).map((c) => ({ ...c, product: s.catalog.get(c.ref) }));
        const req = addRequisition({
          requester: s.request.requester,
          cost_center: s.request.cost_center,
          request_text: s.request.text,
          requirements: (input.requirements ?? []).map(String).slice(0, 12),
          summary: input.summary,
          lines: lineRecords,
          compared,
          total: verdict.total,
          currency: verdict.currency,
          approver: verdict.approver,
          checks: verdict.checks,
          warnings: verdict.warnings,
          duplicate_justification: justification,
        });
        try {
          const order = await createOrder({ requisitionId: req.id, lines: r.lines, baseUrl: s.request.base_url });
          s.result = updateRequisition(req.id, { paypal_order_id: order.id, paypal_status: order.status, approve_url: order.approve_url });
        } catch (err) {
          updateRequisition(req.id, { status: "failed", error: err.message });
          throw err;
        }
        s.emit("requisition", s.result);
        return { status: "submitted", requisition_id: req.id, approver: verdict.approver, total: verdict.total, paypal_order_id: s.result.paypal_order_id };
      }
      case "decline_request": {
        if (s.result) return { status: "error", error: "A result was already recorded for this request." };
        s.result = { declined: true, reason: input.reason, next_step: input.next_step };
        s.emit("declined", s.result);
        return { status: "declined" };
      }
      default:
        return { status: "error", error: `Unknown tool ${name}` };
    }
  } catch (err) {
    console.error(`tool ${name} failed:`, err);
    return { status: "error", error: err.message };
  }
}

let gemini = null;
let modelIdx = 0; // sticks to the first model that worked

async function generate(contents, config) {
  gemini ??= new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
  for (let i = modelIdx; i < GEMINI_MODELS.length; i++) {
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const response = await gemini.models.generateContent({ model: GEMINI_MODELS[i], contents, config });
        modelIdx = i;
        return { response, model: GEMINI_MODELS[i] };
      } catch (err) {
        if (!(err instanceof ApiError)) {
          // Network blips (connect timeout, reset) get one retry on the same model.
          if (attempt === 0 && /fetch failed|ECONNRESET|ETIMEDOUT|UND_ERR/.test(`${err.message} ${err.cause?.code ?? ""}`)) {
            await new Promise((r) => setTimeout(r, 2000));
            continue;
          }
          throw err;
        }
        if (err.status === 503 && attempt === 0) { await new Promise((r) => setTimeout(r, 2000)); continue; }
        if (err.status === 404 || err.status === 429 || err.status === 503) break; // next model
        console.error("gemini error:", err);
        throw new Error(err.status === 400 || err.status === 401 || err.status === 403
          ? "The language model rejected the server's API key." : `Language model request failed (${err.status}).`);
      }
    }
  }
  throw new Error("All configured Gemini models are unavailable or out of free quota right now.");
}

async function geminiLoop(s) {
  const config = {
    systemInstruction: systemPrompt(s.request.cost_center),
    tools: [{ functionDeclarations: TOOL_DEFS.map((t) => ({ name: t.name, description: t.description, parametersJsonSchema: t.parameters })) }],
  };
  const contents = [{ role: "user", parts: [{ text: `Request from ${s.request.requester || "a staff member"}:\n${s.request.text}` }] }];
  const usage = { input_tokens: 0, output_tokens: 0, models: new Set() };
  let nudges = 0;

  for (let turn = 0; turn < MAX_TURNS && !s.result; turn++) {
    const { response, model } = await generate(contents, config);
    usage.models.add(model);
    usage.input_tokens += response.usageMetadata?.promptTokenCount ?? 0;
    usage.output_tokens += response.usageMetadata?.candidatesTokenCount ?? 0;

    const candidate = response.candidates?.[0];
    if (!candidate?.content) throw new Error(`Gemini returned no content (${candidate?.finishReason ?? "no candidate"}).`);
    for (const part of candidate.content.parts ?? []) {
      if (part.text && !part.thought && part.text.trim()) s.emit("note", { text: part.text.trim() });
    }
    const calls = response.functionCalls ?? [];
    if (!calls.length) {
      // The model stopped talking without a decision; ask once more for the required final tool call.
      if (nudges++ >= 2) break;
      contents.push(candidate.content, { role: "user", parts: [{ text: FINISH_NUDGE }] });
      continue;
    }

    contents.push(candidate.content); // unchanged, so thought signatures survive
    const outs = [];
    for (const [i, c] of calls.entries()) { // in order: a submit must see the policy checks before it
      const id = c.id ?? `g${turn}-${i}`;
      s.emit("step", { id, tool: c.name, input: c.args ?? {} });
      const out = await runTool(s, c.name, c.args ?? {});
      s.emit("step_done", { id, ok: out?.status !== "error" });
      outs.push(out);
    }
    contents.push({
      role: "user",
      parts: calls.map((c, i) => ({
        functionResponse: { ...(c.id ? { id: c.id } : {}), name: c.name, response: outs[i]?.status === "error" ? { error: outs[i] } : { output: outs[i] } },
      })),
    });
  }
  return { ...usage, models: [...usage.models] };
}

// Without a model key: search the request text, take the cheapest compliant listing, quantity 1.
async function scriptedRun(s) {
  const step = async (tool, input) => {
    const id = `script-${tool}`;
    s.emit("step", { id, tool, input });
    const out = await runTool(s, tool, input);
    s.emit("step_done", { id, ok: out?.status !== "error" });
    return out;
  };
  s.emit("note", { text: "No language model configured: running the fixed playbook (search, cheapest compliant listing, quantity 1)." });
  const found = await step("search_catalog", { query: s.request.text.slice(0, 120), limit: 8 });
  const pick = (found.results ?? []).filter((r) => r.approved_retailer && r.in_stock && r.price <= policy.max_unit_price)
    .sort((a, b) => a.price - b.price)[0];
  if (!pick) return void await step("decline_request", { reason: "No in-stock listing from an approved retailer matched.", next_step: "Rephrase the request with a more specific product name." });
  const lines = [{ ref: pick.ref, quantity: 1, units_covered: 1, reason: "Cheapest in-stock listing from an approved retailer." }];
  const verdict = await step("check_policy", { lines });
  if (verdict.verdict === "blocked") return void await step("decline_request", { reason: "The cheapest match fails the spend policy.", next_step: "Ask the cost-center owner or raise an RFQ." });
  await step("submit_requisition", { lines, summary: `Scripted pick for: ${s.request.text.slice(0, 200)}` });
}

export async function runAgent(request, emit) {
  const s = new Session(emit, request);
  emit("start", { mode: agentMode, model: MODEL });
  const usage = agentMode === "gemini" ? await geminiLoop(s) : await scriptedRun(s);
  if (!s.result) throw new Error("The agent finished without submitting or declining the request.");
  emit("done", { usage });
  return s.result;
}
