// HTTP server: static UI, the agent run streamed as server-sent events, and the approval endpoints.
import http from "node:http";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { runAgent, agentMode, MODEL } from "./agent.mjs";
import { captureOrder, getOrder, createWalletSetup, confirmWallet, revokeWallet } from "./paypal.mjs";
import { policySummary } from "./policy.mjs";
import { listRequisitions, getRequisition, updateRequisition, allBudgets, resetLedger, policy, getWallet, setWallet, autoPaidToday } from "./store.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC = path.join(here, "..", "public");
const PORT = Number(process.env.PORT || 8788);
const RUNS_PER_HOUR = Number(process.env.RUNS_PER_HOUR || 10);
const MAX_CONCURRENT = Number(process.env.MAX_CONCURRENT || 2);
const ALLOW_RESET = process.env.ALLOW_RESET !== "0";

const TYPES = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8", ".svg": "image/svg+xml", ".png": "image/png", ".ico": "image/x-icon" };

const runsByIp = new Map();
let running = 0;

const clientIp = (req) => (req.headers["x-forwarded-for"]?.split(",")[0] || req.socket.remoteAddress || "?").trim();

function allowRun(ip) {
  const now = Date.now();
  const recent = (runsByIp.get(ip) ?? []).filter((t) => now - t < 3600_000);
  if (recent.length >= RUNS_PER_HOUR) return false;
  recent.push(now);
  runsByIp.set(ip, recent);
  return true;
}

function readBody(req, limit = 8192) {
  return new Promise((resolve, reject) => {
    let data = "";
    req.on("data", (chunk) => {
      data += chunk;
      if (data.length > limit) { reject(new Error("too large")); req.destroy(); }
    });
    req.on("end", () => resolve(data));
    req.on("error", reject);
  });
}

function json(res, status, obj) {
  res.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
  res.end(JSON.stringify(obj));
}

function baseUrl(req) {
  const proto = req.headers["x-forwarded-proto"]?.split(",")[0] || "http";
  return `${proto}://${req.headers["x-forwarded-host"] || req.headers.host}`;
}

async function handleRequest(req, res) {
  let body;
  try {
    const j = JSON.parse(await readBody(req));
    const clean = (v, max) => (typeof v === "string" ? v.replace(/\s+/g, " ").trim().slice(0, max) : "");
    body = {
      text: clean(j.text, 600),
      requester: clean(j.requester, 60) || "Staff member",
      cost_center: clean(j.cost_center, 30),
      base_url: baseUrl(req),
    };
    if (!body.text) throw new Error("Describe what you need.");
    if (!policy.cost_centers[body.cost_center]) throw new Error("Pick a cost center.");
  } catch (err) {
    return json(res, 400, { error: String(err.message) });
  }

  res.writeHead(200, { "content-type": "text/event-stream; charset=utf-8", "cache-control": "no-cache", connection: "keep-alive" });
  const send = (event, data) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  if (running >= MAX_CONCURRENT) { send("error", { message: "The agent is busy with other requests. Try again in a minute." }); return res.end(); }
  if (!allowRun(clientIp(req))) { send("error", { message: `Demo limit reached (${RUNS_PER_HOUR} requests per hour).` }); return res.end(); }

  running += 1;
  let closed = false;
  res.on("close", () => { closed = true; });
  try {
    await runAgent(body, (event, data) => { if (!closed) send(event, data); });
  } catch (err) {
    console.error("request failed:", err);
    if (!closed) send("error", { message: String(err?.message ?? err).slice(0, 300) });
  } finally {
    running -= 1;
    res.end();
  }
}

async function handleCapture(req, res, id) {
  const r = getRequisition(id);
  if (!r) return json(res, 404, { error: "No such requisition." });
  let orderId;
  try { orderId = JSON.parse((await readBody(req)) || "{}").order_id; } catch { /* ignore */ }
  if (orderId && orderId !== r.paypal_order_id) return json(res, 400, { error: "Order id does not match this requisition." });
  if (r.status !== "awaiting_approval") return json(res, 409, { error: `Requisition is ${r.status}.` });
  try {
    const cap = await captureOrder(r.paypal_order_id);
    if (cap.status !== "COMPLETED") {
      return json(res, 402, { error: `PayPal returned ${cap.status ?? "an unexpected status"}; nothing was recorded.` });
    }
    const updated = updateRequisition(id, {
      status: "ordered",
      approved_at: new Date().toISOString(),
      approved_by: cap.payer_name || cap.payer_email || r.approver,
      payer_email: cap.payer_email,
      capture_id: cap.capture_id,
      capture_status: cap.capture_status,
      paypal_status: cap.status,
    });
    json(res, 200, updated);
  } catch (err) {
    console.error("capture failed:", err);
    json(res, 502, { error: String(err.message).slice(0, 300) });
  }
}

async function handleReject(req, res, id) {
  const r = getRequisition(id);
  if (!r) return json(res, 404, { error: "No such requisition." });
  if (r.status !== "awaiting_approval") return json(res, 409, { error: `Requisition is ${r.status}.` });
  let reason = "";
  try { reason = String(JSON.parse((await readBody(req)) || "{}").reason ?? "").slice(0, 300); } catch { /* ignore */ }
  json(res, 200, updateRequisition(id, { status: "rejected", rejected_at: new Date().toISOString(), reject_reason: reason || "No reason given." }));
}

async function handleOrderStatus(res, id) {
  const r = getRequisition(id);
  if (!r?.paypal_order_id) return json(res, 404, { error: "No PayPal order for this requisition." });
  try {
    const o = await getOrder(r.paypal_order_id);
    json(res, 200, { id: o.id, status: o.status, create_time: o.create_time, update_time: o.update_time,
      amount: o.purchase_units?.[0]?.amount, captures: o.purchase_units?.[0]?.payments?.captures?.map((c) => ({ id: c.id, status: c.status, amount: c.amount })) ?? [] });
  } catch (err) {
    json(res, 502, { error: String(err.message).slice(0, 300) });
  }
}

// ---- agent wallet
const pendingSetups = new Map(); // setup token id -> created at

function walletStatus() {
  const w = getWallet();
  const limits = policy.agent_wallet ?? {};
  return {
    authorized: !!w,
    authorized_by: w?.authorized_by ?? null,
    payer_email: w?.payer_email ?? null,
    authorized_at: w?.authorized_at ?? null,
    max_order_total: limits.max_order_total ?? 0,
    max_per_day: limits.max_per_day ?? 0,
    spent_today: autoPaidToday(),
  };
}

async function handleWalletSetup(req, res) {
  try {
    const setup = await createWalletSetup({ baseUrl: baseUrl(req) });
    pendingSetups.set(setup.setup_token_id, Date.now());
    json(res, 200, setup);
  } catch (err) {
    console.error("wallet setup failed:", err);
    json(res, 502, { error: String(err.message).slice(0, 300) });
  }
}

async function handleWalletConfirm(req, res) {
  let id;
  try { id = String(JSON.parse(await readBody(req)).setup_token_id ?? ""); } catch { /* ignore */ }
  if (!id || !pendingSetups.has(id)) return json(res, 400, { error: "Unknown or expired authorization. Start again from the wallet card." });
  try {
    const t = await confirmWallet(id);
    pendingSetups.delete(id);
    const old = getWallet();
    setWallet({ ...t, authorized_by: t.payer_name || t.payer_email || "a manager", authorized_at: new Date().toISOString() });
    if (old?.payment_token_id && old.payment_token_id !== t.payment_token_id) revokeWallet(old.payment_token_id).catch(() => {});
    json(res, 200, walletStatus());
  } catch (err) {
    console.error("wallet confirm failed:", err);
    json(res, 502, { error: String(err.message).slice(0, 300) });
  }
}

async function handleWalletRevoke(res) {
  const w = getWallet();
  if (!w) return json(res, 200, walletStatus());
  try {
    await revokeWallet(w.payment_token_id);
  } catch (err) {
    console.error("wallet revoke at PayPal failed (removing locally anyway):", err.message);
  }
  setWallet(null);
  json(res, 200, walletStatus());
}

async function serveStatic(req, res) {
  const url = new URL(req.url, "http://x");
  const rel = url.pathname === "/" ? "index.html" : url.pathname.slice(1);
  const file = path.normalize(path.join(PUBLIC, rel));
  if (!file.startsWith(PUBLIC + path.sep)) return json(res, 404, { error: "not found" });
  try {
    const body = await readFile(file);
    res.writeHead(200, { "content-type": TYPES[path.extname(file)] ?? "application/octet-stream" });
    res.end(body);
  } catch {
    json(res, 404, { error: "not found" });
  }
}

const server = http.createServer((req, res) => {
  const { pathname } = new URL(req.url, "http://x");
  const m = pathname.match(/^\/api\/requisitions\/(REQ-\d+)(?:\/(capture|reject|order))?$/);
  if (req.method === "POST" && pathname === "/api/requests") return handleRequest(req, res);
  if (req.method === "POST" && m?.[2] === "capture") return handleCapture(req, res, m[1]);
  if (req.method === "POST" && m?.[2] === "reject") return handleReject(req, res, m[1]);
  if (req.method === "GET" && m?.[2] === "order") return handleOrderStatus(res, m[1]);
  if (req.method === "GET" && m && !m[2]) { const r = getRequisition(m[1]); return r ? json(res, 200, r) : json(res, 404, { error: "not found" }); }
  if (req.method === "GET" && pathname === "/api/requisitions") return json(res, 200, listRequisitions());
  if (req.method === "GET" && pathname === "/api/budgets") return json(res, 200, allBudgets());
  if (req.method === "GET" && pathname === "/api/wallet") return json(res, 200, walletStatus());
  if (req.method === "POST" && pathname === "/api/wallet/setup") return handleWalletSetup(req, res);
  if (req.method === "POST" && pathname === "/api/wallet/confirm") return handleWalletConfirm(req, res);
  if (req.method === "POST" && pathname === "/api/wallet/revoke") return handleWalletRevoke(res);
  if (req.method === "GET" && pathname === "/api/config") {
    return json(res, 200, { paypal_client_id: process.env.PAYPAL_CLIENT_ID, paypal_env: process.env.PAYPAL_ENV ?? "sandbox",
      agent: agentMode, model: MODEL, policy: policySummary(), allow_reset: ALLOW_RESET });
  }
  if (req.method === "POST" && pathname === "/api/reset" && ALLOW_RESET) { resetLedger(); return json(res, 200, { ok: true }); }
  if (req.method === "GET") return serveStatic(req, res);
  json(res, 405, { error: "method not allowed" });
});

server.listen(PORT, () => {
  console.log(`Procure agent on http://localhost:${PORT} (agent: ${agentMode}${MODEL ? `, model: ${MODEL}` : ""}, paypal: ${process.env.PAYPAL_ENV ?? "sandbox"})`);
});
