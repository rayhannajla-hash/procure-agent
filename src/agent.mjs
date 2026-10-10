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
const MAX_TURNS = 12;

export const agentMode = process.env.GEMINI_API_KEY ? "gemini" : "scripted";
export const MODEL = agentMode === "gemini" ? GEMINI_MODELS[0] : null;

const TOOL_DEFS = [
  {
    name: "search_catalog",
    description: "Search live retail listings (Channel3, 100M+ products) for an item to buy. Use short English product terms with the key spec, e.g. 'temperature controlled soldering station 60W'. Only in-stock listings come back. Each result has a ref (P1, P2, ...) that the other tools use.",
    parameters: {
      type: "object",
      properties: {
        query: { type: "string", description: "Product search terms." },
        max_unit_price: { type: "number", description: "Optional price ceiling per unit in USD." },
        limit: { type: "integer", description: "How many listings to return, 3-8. Default 6." },
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
        lines: {
          type: "array",
          items: {
            type: "object",
            properties: {
              ref: { type: "string" },
              quantity: { type: "integer" },
              reason: { type: "string", description: "One sentence: why this listing fits the request." },
            },
            required: ["ref", "quantity", "reason"],
          },
        },
        summary: { type: "string", description: "Two or three sentences for the approver: what is being bought, for what, and why this choice." },
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
- Work out exactly what is needed: item, quantity, must-have specs, budget hints, urgency. Keep the requested quantity; never change it silently.
- Search with one to three focused queries. Compare listings on fit to the spec first, then price, approved retailer, stock and rating. Prefer listings from approved retailers.
- Pick the best-value listing that meets the spec. Run check_policy on the basket. If a rule fails, adapt (another listing, an approved retailer, a cheaper model that still meets the spec) and check again.
- Finish with exactly one of: submit_requisition (everything passes), or decline_request (it cannot be bought within policy). When the order is too large or the budget is short, decline and point to the right next step instead of trimming the order.
- Use only refs that came back from search_catalog. Never invent products, prices, retailers or stock.

Policy in force (enforced in code, you cannot override it): one order at most $${p.hard_limit_per_order}; unit price at most $${p.max_unit_price}; 1-${p.max_quantity_per_line} units per line; in stock only; approved retailers only (${p.approved_retailers.join(", ")}); no restricted items (${p.blocked_keywords.join(", ")}). Approvers: ${p.approval_tiers.map((t) => `up to $${t.max_total} -> ${t.approver}`).join("; ")}.

Write short, plain notes between tool calls, in the requester's language.`;
}

class Session {
  constructor(emit, request) {
    this.emit = emit;
    this.request = request;
    this.catalog = new Map(); // ref -> product
    this.seq = 0;
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
    return { lines: lines.map((l) => ({ ref: l.ref, product: this.catalog.get(l.ref), quantity: Number(l.quantity), reason: l.reason })) };
  }
}

async function runTool(s, name, input) {
  try {
    switch (name) {
      case "search_catalog": {
        const results = await searchCatalog({ query: input.query, maxUnitPrice: input.max_unit_price, limit: input.limit ?? 6 });
        const rows = results.map((p) => ({ ref: s.remember(p), ...p, approved_retailer: isApprovedRetailer(p.retailer) }));
        s.emit("results", { query: input.query, results: rows });
        return {
          results: rows.map(({ ref, title, brand, price, currency, retailer, approved_retailer, in_stock, rating, key_features }) =>
            ({ ref, title, brand, price, currency, retailer, approved_retailer, in_stock, rating, key_features })),
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
        const lineRecords = r.lines.map(({ ref, product, quantity, reason }) => ({ ref, quantity, reason, product, line_total: Math.round(product.price * quantity * 100) / 100 }));
        const compared = (input.compared ?? []).filter((c) => s.catalog.has(c.ref)).map((c) => ({ ...c, product: s.catalog.get(c.ref) }));
        const req = addRequisition({
          requester: s.request.requester,
          cost_center: s.request.cost_center,
          request_text: s.request.text,
          summary: input.summary,
          lines: lineRecords,
          compared,
          total: verdict.total,
          currency: verdict.currency,
          approver: verdict.approver,
          checks: verdict.checks,
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
        if (!(err instanceof ApiError)) throw err;
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
    if (!calls.length) break;

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
  const lines = [{ ref: pick.ref, quantity: 1, reason: "Cheapest in-stock listing from an approved retailer." }];
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
