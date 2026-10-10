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

// ---- Vault (agent wallet). The toolkit has no vault tools, so these call the REST API directly with the
// toolkit's own authenticated client.
async function rest(method, path, body, requestId) {
  const client = tk().client;
  const headers = { ...(await client.getHeaders()), "Content-Type": "application/json" };
  if (requestId) headers["PayPal-Request-Id"] = requestId;
  const res = await fetch(`${client.getBaseUrl()}${path}`, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(30000),
  });
  const text = await res.text();
  const data = text ? JSON.parse(text) : {};
  if (!res.ok) throw new Error(`PayPal ${method} ${path} failed (${res.status}): ${JSON.stringify(data).slice(0, 300)}`);
  return data;
}

// Step 1: a setup token the manager approves in PayPal (no purchase).
export async function createWalletSetup({ baseUrl }) {
  const data = await rest("POST", "/v3/vault/setup-tokens", {
    payment_source: {
      paypal: {
        description: "Procure Agent: small purchases the agent may pay within company policy",
        usage_type: "MERCHANT",
        customer_type: "CONSUMER",
        permit_multiple_payment_tokens: false,
        experience_context: {
          brand_name: "Procure Agent",
          shipping_preference: "NO_SHIPPING",
          vault_instruction: "ON_PAYER_APPROVAL",
          return_url: `${baseUrl}/?wallet=approved`,
          cancel_url: `${baseUrl}/?wallet=cancelled`,
        },
      },
    },
  }, `setup-${Date.now()}`);
  return { setup_token_id: data.id, approve_url: data.links?.find((l) => l.rel === "approve")?.href ?? null };
}

// Step 2: after approval, turn the setup token into a reusable payment token.
export async function confirmWallet(setupTokenId) {
  const data = await rest("POST", "/v3/vault/payment-tokens", { payment_source: { token: { id: setupTokenId, type: "SETUP_TOKEN" } } }, `token-${setupTokenId}`);
  return {
    payment_token_id: data.id,
    customer_id: data.customer?.id ?? null,
    payer_email: data.payment_source?.paypal?.email_address ?? null,
    payer_name: [data.payment_source?.paypal?.name?.given_name, data.payment_source?.paypal?.name?.surname].filter(Boolean).join(" ") || null,
  };
}

export const revokeWallet = (paymentTokenId) => rest("DELETE", `/v3/vault/payment-tokens/${encodeURIComponent(paymentTokenId)}`);

// Merchant-initiated payment with the saved PayPal wallet: the order is created and captured in one call.
export async function payWithWallet({ requisitionId, lines, vaultId }) {
  const items = lines.map(({ product: p, quantity }) => ({
    name: cut(p.title, 127),
    quantity: String(quantity),
    unit_amount: { currency_code: "USD", value: p.price.toFixed(2) },
    description: cut(`${requisitionId} | ${p.retailer ?? "retailer"} | Channel3 ${p.product_id}`, 127),
  }));
  const total = lines.reduce((s, { product: p, quantity }) => s + Math.round(p.price * 100) * quantity, 0) / 100;
  const order = await rest("POST", "/v2/checkout/orders", {
    intent: "CAPTURE",
    purchase_units: [{
      reference_id: requisitionId,
      description: `Requisition ${requisitionId} (paid by the agent wallet)`,
      amount: { currency_code: "USD", value: total.toFixed(2), breakdown: { item_total: { currency_code: "USD", value: total.toFixed(2) } } },
      items,
    }],
    payment_source: { paypal: { vault_id: vaultId } },
  }, `pay-${requisitionId}`);
  const capture = order.purchase_units?.[0]?.payments?.captures?.[0];
  return { id: order.id, status: order.status, capture_id: capture?.id ?? null, capture_status: capture?.status ?? null };
}

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
