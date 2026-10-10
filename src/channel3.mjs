// Product search over Channel3's catalog (https://docs.trychannel3.com). Results are trimmed to what
// the agent and the policy engine need, so the model sees a short, comparable list.
import { isApprovedRetailer } from "./policy.mjs";

const BASE = "https://api.trychannel3.com/v1";

async function call(path, body) {
  const res = await fetch(`${BASE}${path}`, {
    method: body ? "POST" : "GET",
    headers: { "x-api-key": process.env.CHANNEL3_API_KEY, "Content-Type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(20000),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`Channel3 ${path} failed (${res.status}): ${text.slice(0, 200)}`);
  }
  return res.json();
}

function bestOffer(p) {
  const offers = (p.offers ?? []).filter((o) => o.price?.price != null);
  // Prefer an in-stock offer from an approved retailer, then any in-stock offer, then the cheapest.
  const score = (o) => (o.availability === "InStock" ? 0 : 2) + (isApprovedRetailer(o.domain) ? 0 : 1);
  return offers.sort((a, b) => score(a) - score(b) || a.price.price - b.price.price)[0] ?? null;
}

export function normalize(p) {
  const o = bestOffer(p);
  if (!o) return null;
  const rating = p.ratings ?? null;
  return {
    product_id: p.id,
    title: p.title,
    brand: p.brands?.[0]?.name ?? null,
    category: typeof p.category === "string" ? p.category : p.category?.title ?? null,
    price: o.price.price,
    currency: o.price.currency,
    retailer: o.domain ?? null,
    in_stock: o.availability === "InStock",
    url: o.url,
    image: (p.images?.find((i) => i.is_main_image) ?? p.images?.[0])?.url ?? null,
    rating: rating?.average ?? rating?.rating ?? null,
    review_count: rating?.count ?? rating?.review_count ?? null,
    key_features: (p.key_features ?? []).slice(0, 4),
  };
}

export async function searchCatalog({ query, maxUnitPrice, limit = 6 }) {
  const filters = { availability: ["InStock"] };
  if (maxUnitPrice) filters.price = { max_price: maxUnitPrice };
  const data = await call("/search", { query, filters, limit: Math.min(Math.max(limit, 1), 10) });
  return (data.products ?? []).map(normalize).filter(Boolean);
}
