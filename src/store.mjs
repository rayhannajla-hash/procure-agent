// Requisitions and purchase orders, persisted to a JSON file. Small on purpose: one plant, one demo.
import { readFileSync, writeFileSync, renameSync, mkdirSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const DATA_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "data");
// The ledger can live elsewhere (on Cloud Run: a Cloud Storage volume, so it survives scale-to-zero).
const LEDGER_DIR = process.env.LEDGER_DIR || DATA_DIR;
const LEDGER = join(LEDGER_DIR, "ledger.json");
const POLICY = join(DATA_DIR, "policy.json");

export const policy = JSON.parse(readFileSync(POLICY, "utf8"));

const empty = () => ({ seq: 0, po_seq: 0, requisitions: [] });
let db = existsSync(LEDGER) ? JSON.parse(readFileSync(LEDGER, "utf8")) : empty();

function save() {
  mkdirSync(LEDGER_DIR, { recursive: true });
  const tmp = `${LEDGER}.tmp`;
  writeFileSync(tmp, JSON.stringify(db, null, 2));
  renameSync(tmp, LEDGER);
}

const monthKey = (iso) => iso.slice(0, 7);

export function listRequisitions() {
  return [...db.requisitions].sort((a, b) => b.created_at.localeCompare(a.created_at));
}

export const getRequisition = (id) => db.requisitions.find((r) => r.id === id);

export function addRequisition(fields) {
  db.seq += 1;
  const req = {
    id: `REQ-${String(db.seq).padStart(4, "0")}`,
    status: "awaiting_approval",
    created_at: new Date().toISOString(),
    ...fields,
  };
  db.requisitions.push(req);
  save();
  return req;
}

export function updateRequisition(id, patch) {
  const req = getRequisition(id);
  if (!req) return null;
  Object.assign(req, patch);
  if (patch.status === "ordered" && !req.po_number) {
    db.po_seq += 1;
    req.po_number = `PO-${new Date().getFullYear()}-${String(db.po_seq).padStart(4, "0")}`;
  }
  save();
  return req;
}

// Spent = paid this month. Committed = awaiting approval this month (reserved so two requests can't double-spend).
export function budgetFor(costCenter, now = new Date().toISOString()) {
  const cc = policy.cost_centers[costCenter];
  if (!cc) return null;
  let spent = 0;
  let committed = 0;
  for (const r of db.requisitions) {
    if (r.cost_center !== costCenter || monthKey(r.created_at) !== monthKey(now)) continue;
    if (r.status === "ordered") spent += r.total;
    else if (r.status === "awaiting_approval") committed += r.total;
  }
  const round = (n) => Math.round(n * 100) / 100;
  return {
    cost_center: costCenter,
    name: cc.name,
    monthly_budget: cc.monthly_budget,
    spent: round(spent),
    committed: round(committed),
    available: round(cc.monthly_budget - spent - committed),
  };
}

export const allBudgets = () => Object.keys(policy.cost_centers).map((k) => budgetFor(k));

const STOP = new Set(["the", "and", "for", "with", "pack", "pcs", "set", "new", "inch", "black", "blue", "red", "orange", "model"]);
const words = (t) => new Set(String(t).toLowerCase().match(/[a-z0-9]{3,}/g)?.filter((w) => !STOP.has(w)) ?? []);
// Same item, or the same kind of item: titles mostly overlap, or same catalog category with at least two shared words.
function similarItems(a, b) {
  if (!a || !b) return false;
  if (a.product_id && a.product_id === b.product_id) return true;
  const A = words(a.title);
  const B = words(b.title);
  if (!A.size || !B.size) return false;
  const shared = [...A].filter((w) => B.has(w)).length;
  if (shared / new Set([...A, ...B]).size >= 0.5 || (shared >= 3 && shared === Math.min(A.size, B.size))) return true;
  return !!a.category && a.category === b.category && shared >= 2;
}

// Ordered or pending purchases of the same or a very similar item by the same cost center in the last `days` days.
export function recentSimilar(costCenter, product, days = 14, now = Date.now()) {
  const since = now - days * 86400_000;
  const hits = [];
  for (const r of db.requisitions) {
    if (r.cost_center !== costCenter || !["ordered", "awaiting_approval"].includes(r.status)) continue;
    if (Date.parse(r.created_at) < since) continue;
    for (const l of r.lines ?? []) {
      if (similarItems(l.product, product)) {
        hits.push({ id: r.id, po_number: r.po_number ?? null, status: r.status, created_at: r.created_at, title: l.product.title, quantity: l.quantity });
      }
    }
  }
  return hits.sort((x, y) => y.created_at.localeCompare(x.created_at)).slice(0, 3);
}

// Demo reset clears requisitions and POs but keeps the agent wallet, so a judge does not have to re-authorize.
export function resetLedger() {
  db = { ...empty(), wallet: db.wallet ?? null };
  save();
}

// The agent wallet: a PayPal payment token (Vault) a manager approved for small, policy-compliant purchases.
export const getWallet = () => db.wallet ?? null;

export function setWallet(wallet) {
  db.wallet = wallet;
  save();
  return wallet;
}

// What the agent has paid from the wallet since midnight UTC.
export function autoPaidToday(now = new Date().toISOString()) {
  const day = now.slice(0, 10);
  return Math.round(db.requisitions
    .filter((r) => r.auto_paid && r.status === "ordered" && r.created_at.slice(0, 10) === day)
    .reduce((sum, r) => sum + r.total, 0) * 100) / 100;
}
