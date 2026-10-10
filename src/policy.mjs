// The spend policy, enforced in code. The agent can ask for a check, but it cannot talk its way past one:
// submit_requisition re-runs evaluate() and refuses to create a PayPal order when any rule fails.
import { policy, budgetFor, recentSimilar } from "./store.mjs";

const money = (n) => `$${n.toFixed(2)}`;
const round = (n) => Math.round(n * 100) / 100;

export const isApprovedRetailer = (domain) =>
  !!domain && policy.approved_retailers.some((d) => domain === d || domain.endsWith(`.${d}`));

export function approverFor(total) {
  return policy.approval_tiers.find((t) => total <= t.max_total)?.approver ?? null;
}

// lines: [{ product, quantity }] where product is a catalog entry from channel3.mjs.
export function evaluate({ costCenter, lines }) {
  const checks = [];
  const add = (rule, pass, detail) => checks.push({ rule, pass, detail });

  const budget = budgetFor(costCenter);
  if (!budget) add("Cost center", false, `Unknown cost center "${costCenter}".`);

  if (!lines.length) add("Line items", false, "The requisition has no items.");

  let total = 0;
  for (const { product: p, quantity } of lines) {
    const label = p.title.length > 60 ? `${p.title.slice(0, 57)}...` : p.title;
    const qtyOk = Number.isInteger(quantity) && quantity >= 1 && quantity <= policy.max_quantity_per_line;
    add("Quantity", qtyOk, qtyOk
      ? `${quantity} x ${label}`
      : `${label}: quantity ${quantity} is outside 1-${policy.max_quantity_per_line}.`);

    if (p.currency !== policy.currency) add("Currency", false, `${label} is priced in ${p.currency}, policy pays in ${policy.currency}.`);

    const unitOk = p.price <= policy.max_unit_price;
    add("Unit price cap", unitOk, `${label}: ${money(p.price)} vs cap ${money(policy.max_unit_price)}.`);

    const retailerOk = isApprovedRetailer(p.retailer);
    add("Approved retailer", retailerOk, retailerOk
      ? `${p.retailer} is on the approved list.`
      : `${p.retailer || "Unknown retailer"} is not on the approved list.`);

    if (policy.require_in_stock) {
      add("In stock", p.in_stock, p.in_stock ? `${label} is in stock.` : `${label} is not listed as in stock.`);
    }

    const text = `${p.title} ${p.category ?? ""}`.toLowerCase();
    const hit = policy.blocked_keywords.find((k) => text.includes(k));
    if (hit) add("Restricted category", false, `${label} matches restricted term "${hit}".`);

    total += p.price * (qtyOk ? quantity : 0);
  }
  total = round(total);

  const limitOk = total <= policy.hard_limit_per_order;
  add("Order limit", limitOk, limitOk
    ? `Order total ${money(total)} is within the ${money(policy.hard_limit_per_order)} per-order limit.`
    : `Order total ${money(total)} exceeds the ${money(policy.hard_limit_per_order)} per-order limit; this needs a formal RFQ, not a quick buy.`);

  if (budget) {
    const budgetOk = total <= budget.available;
    add("Monthly budget", budgetOk,
      `${budget.name}: ${money(budget.available)} available of ${money(budget.monthly_budget)} ` +
      `(${money(budget.spent)} spent, ${money(budget.committed)} awaiting approval); this order needs ${money(total)}.`);
  }

  // Advisory only: a recent purchase of the same kind of item does not block, but the agent and the approver see it.
  const warnings = [];
  for (const { product: p } of lines) {
    for (const h of recentSimilar(costCenter, p, policy.duplicate_window_days ?? 14)) {
      const when = new Date(h.created_at).toISOString().slice(0, 10);
      warnings.push({
        rule: "Recent similar purchase",
        detail: `${costCenter} ${h.status === "ordered" ? `bought ${h.quantity} x ${h.title} on ${when} (${h.po_number})` : `already has ${h.quantity} x ${h.title} awaiting approval (${h.id}, ${when})`}.`,
      });
    }
  }

  const blocked = checks.some((c) => !c.pass);
  return {
    verdict: blocked ? "blocked" : "needs_approval",
    total,
    currency: policy.currency,
    approver: blocked ? null : approverFor(total),
    checks,
    warnings,
    budget,
  };
}

export function policySummary() {
  return {
    company: policy.company,
    currency: policy.currency,
    hard_limit_per_order: policy.hard_limit_per_order,
    max_unit_price: policy.max_unit_price,
    max_quantity_per_line: policy.max_quantity_per_line,
    require_in_stock: policy.require_in_stock,
    approval_tiers: policy.approval_tiers,
    approved_retailers: policy.approved_retailers,
    blocked_keywords: policy.blocked_keywords,
    cost_centers: Object.entries(policy.cost_centers).map(([id, c]) => ({ id, ...c })),
  };
}
