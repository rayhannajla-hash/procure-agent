// Product search over Channel3's catalog (https://docs.trychannel3.com). Results are trimmed to what
// the agent and the policy engine need, so the model sees a short, comparable list.
import { isApprovedRetailer } from "./policy.mjs";
import { policy } from "./store.mjs";

const BASE = "https://api.trychannel3.com/v1";

async function call(path, body = null) {
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
    key_features: (p.key_features ?? []).slice(0, 5),
    description: typeof p.description === "string" ? p.description.replace(/\s+/g, " ").trim().slice(0, 280) : null,
  };
}

// Channel3 filters by website id, so the approved-retailer domains are resolved once and cached.
let approvedIds = null;
async function approvedWebsiteIds() {
  if (approvedIds) return approvedIds;
  const ids = await Promise.all(policy.approved_retailers.map(async (domain) => {
    try {
      const q = encodeURIComponent(domain.split(".")[0]);
      const data = await call(`/websites/search?query=${q}&limit=5`);
      return data.websites?.find((w) => w.url?.replace(/^www\./, "") === domain)?.id ?? null;
    } catch {
      return null;
    }
  }));
  approvedIds = ids.filter(Boolean);
  return approvedIds;
}

export async function searchCatalog({ query, maxUnitPrice, limit = 6, approvedOnly = true }) {
  const filters = { availability: ["InStock"] };
  if (maxUnitPrice) filters.price = { max_price: maxUnitPrice };
  if (approvedOnly) {
    const ids = await approvedWebsiteIds();
    if (ids.length) filters.website_ids = ids;
  }
  const data = await call("/search", { query, filters, limit: Math.min(Math.max(limit, 1), 10) });
  return (data.products ?? []).map(normalize).filter(Boolean);
}
