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

export function resetLedger() {
  db = empty();
  save();
}
