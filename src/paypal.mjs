// PayPal, through PayPal's own Agent Toolkit (@paypal/agent-toolkit). Every payment call goes through the
// toolkit's tool handlers, the same ones an LLM would call, but this module only exposes the operations
// the purchasing workflow allows: create an order for a policy-approved requisition, read it, capture it
// after a human approves it in PayPal.
import { PayPalAgentToolkit } from "@paypal/agent-toolkit/openai";

let toolkit = null;
const tk = () => (toolkit ??= new PayPalAgentToolkit({
  clientId: process.env.PAYPAL_CLIENT_ID,
  clientSecret: process.env.PAYPAL_CLIENT_SECRET,
  configuration: {
    actions: { orders: { create: true, get: true, capture: true }, shipment: { create: true, get: true } },
    context: { sandbox: (process.env.PAYPAL_ENV ?? "sandbox") !== "live" },
  },
}));

let seq = 0;
async function run(name, args) {
  const result = await tk().handleToolCall({
    id: `pp-${Date.now()}-${seq++}`,
    type: "function",
    function: { name, arguments: JSON.stringify(args) },
  });
  let data;
  try { data = JSON.parse(result.content); } catch { data = { raw: result.content }; }
  if (data?.status === "error" || data?.error || data?.name === "UNPROCESSABLE_ENTITY") {
    throw new Error(`PayPal ${name} failed: ${JSON.stringify(data).slice(0, 300)}`);
  }
  return data;
}

const cut = (s, n) => (s.length > n ? `${s.slice(0, n - 3)}...` : s);

export async function createOrder({ requisitionId, lines, baseUrl }) {
  const order = await run("create_order", {
    currencyCode: "USD",
    items: lines.map(({ product: p, quantity }) => ({
      name: cut(p.title, 127),
      quantity,
      itemCost: p.price,
      itemTotal: Math.round(p.price * quantity * 100) / 100,
      description: cut(`${requisitionId} | ${p.retailer ?? "retailer"} | Channel3 ${p.product_id}`, 127),
    })),
    shippingCost: 0,
    notes: `Requisition ${requisitionId}`,
    returnUrl: `${baseUrl}/?approved=${requisitionId}`,
    cancelUrl: `${baseUrl}/?cancelled=${requisitionId}`,
  });
  if (!order.id) throw new Error("PayPal did not return an order id.");
  return { id: order.id, status: order.status, approve_url: order.links?.find((l) => l.rel === "payer-action" || l.rel === "approve")?.href ?? null };
}

export const getOrder = (id) => run("get_order", { id });

export async function captureOrder(id) {
  const out = await run("pay_order", { id });
  const order = out.response ?? out;
  const capture = order.purchase_units?.[0]?.payments?.captures?.[0];
  return {
    status: order.status,
    capture_id: capture?.id ?? null,
    capture_status: capture?.status ?? null,
    amount: capture?.amount ?? null,
    payer_email: order.payer?.email_address ?? null,
    payer_name: [order.payer?.name?.given_name, order.payer?.name?.surname].filter(Boolean).join(" ") || null,
  };
}
