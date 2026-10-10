# Procure Agent

**A purchasing agent for small factories.** A technician types what the line needs. The agent finds it in live retail listings, checks it against the company's spend policy, and routes it to the right approver. Money moves only when that person approves the payment in PayPal.

Built for the [PayPal AI Hackathon](https://paypalaihackathon.devpost.com/) (2026). It runs on the **PayPal sandbox**, so no real money moves.

## The problem

In a small plant, the small purchases are the messy ones: a soldering station for rework, ESD mats for the QA bench, safety glasses for new operators. Nobody runs a tender for a $70 tool, so these buys happen through whoever has a card, with screenshots in a chat for approval, no comparison, and no record against the department budget until month end.

Procure Agent gives that "quick buy" a proper path without slowing it down:

1. **Request in plain words.** "Line 2 needs 2 temperature-controlled soldering stations, 60-80W, under $100 each."
2. **The agent shops.** It searches 100M+ live listings through [Channel3](https://trychannel3.com) and compares them on spec, price, stock and retailer.
3. **The policy decides, in code.** Order limit, unit-price cap, approved retailers, restricted items, and the cost center's remaining monthly budget. The agent can dry-run the policy, but it cannot talk its way past it.
4. **A person approves in PayPal.** The agent creates a PayPal order and routes it to the approver for that amount (Line Supervisor up to $150, Plant Manager up to $600). The approver sees the request, the chosen listing, what else was compared, and every policy check, then pays with PayPal Checkout or rejects.
5. **A purchase order is recorded.** The capture is confirmed with PayPal and a PO number is issued against the cost center.

## How it uses PayPal

All server-side PayPal calls go through PayPal's own **Agent Toolkit** ([`@paypal/agent-toolkit`](https://www.npmjs.com/package/@paypal/agent-toolkit)), the same tool handlers an LLM would call:

| Toolkit tool | Where | What it does here |
|---|---|---|
| `create_order` | `src/paypal.mjs` | Creates the order for a policy-approved requisition (line items, quantities, requisition reference) |
| `pay_order` | `src/paypal.mjs` | Captures the payment after the approver confirms in PayPal Checkout |
| `get_order` | `src/paypal.mjs` | Reads the order's live status from PayPal (`GET /api/requisitions/:id/order`) |

On the approver's screen, the **PayPal JavaScript SDK** renders PayPal Checkout for the order the agent created (`createOrder` returns the agent's order id; `onApprove` triggers the capture).

The design choice: the model never holds a "pay" tool. It can only *propose* a basket. `submit_requisition` re-runs the policy in code, creates the PayPal order only if every rule passes, and the payment itself needs a human to approve it inside PayPal. That keeps a fast agent from becoming a fast way to spend money.

## How it uses AI

- **Google Gemini** (via `@google/genai`) runs a tool-use loop in `src/agent.mjs`. It turns the request and its use into must-have specs (operators working indoors need clear lenses, bench tools should be ESD-safe), rules out listings that contradict them, works out pack sizes (10 pieces is not 10 boxes of 12), adapts when a policy check fails, and writes the justification and the "also compared" notes the approver sees. The approver sees the must-haves next to the listing that meets them. If one Gemini model is unavailable or out of quota, the next one in `GEMINI_MODEL` is tried.
- **Channel3** provides the product data: titles, prices, stock, retailer and buy links across 25,000+ retailers.
- Without a Gemini key, the app still runs a fixed, non-AI playbook (search, cheapest compliant listing) so the PayPal flow can be tested.

Agent tools:

| Tool | Purpose |
|---|---|
| `search_catalog` | Channel3 search, in-stock listings from approved retailers only (filtered by Channel3 website id), optional price ceiling; at most 4 searches per request |
| `check_policy` | Dry-run the spend policy on a draft basket |
| `submit_requisition` | Final basket: policy re-check in code, then PayPal `create_order`, routed to the approver |
| `decline_request` | Stop when the request cannot be met within policy, and say what to do instead (for example, raise an RFQ) |

## Try it

### Hosted demo

**https://procure-agent-951814937148.us-central1.run.app**

Runs on Google Cloud Run against the PayPal sandbox. Approving a payment needs a PayPal sandbox buyer account; test credentials for judges are in the Devpost submission's testing instructions.

### Run it yourself

Requirements: Node.js 22+, a PayPal developer account (free), a Channel3 API key (free tier), and optionally a Gemini API key.

```bash
git clone https://github.com/rayhannajla-hash/procure-agent.git
cd procure-agent
npm install
cp .env.example .env   # fill in the keys
npm start              # http://localhost:8788
```

To approve a payment you need a **sandbox Personal (buyer) account**: PayPal Developer Dashboard > Testing Tools > Sandbox Accounts. Log in to PayPal Checkout with that account, not a real PayPal login and not the sandbox Business account (that one is the seller).

### A 2-minute walkthrough

1. **Request** tab: pick the soldering-station example and run it. Watch the searches, the policy checks, and the requisition being routed.
2. **Approvals** tab: approve it with PayPal (sandbox buyer account). A PO number and the PayPal capture id appear.
3. **Orders & budget** tab: the cost center's budget moves; the ledger shows the PO and capture.
4. Try the "15 cordless drills, the best ones" example: it exceeds the per-order limit, so the agent declines and points to an RFQ instead of ordering.

## Spend policy

`data/policy.json` holds the rules, and you can edit it:

- one order at most $600; unit price at most $400; 1-20 units per line; in stock only
- approved retailers only (Micro Center, Newegg, Home Depot, Lowe's, Northern Tool, Staples, Walmart, Target, and others); searches are restricted to them
- at most 4 catalog searches per request, so a vague request cannot burn the search budget
- restricted items blocked (gift cards, alcohol, tobacco, and so on)
- monthly budgets per cost center (Line 2 Maintenance, QA Lab, Safety)
- approval tiers by amount: Line Supervisor up to $150, Plant Manager up to $600

## Architecture

```
public/            UI: request form + live agent trace, approver inbox (PayPal JS SDK), ledger
src/server.mjs     HTTP server, server-sent events for the agent run, approve / reject / status endpoints
src/agent.mjs      Gemini tool-use loop (or the scripted fallback)
src/policy.mjs     spend policy, evaluated in code
src/channel3.mjs   Channel3 search client
src/paypal.mjs     PayPal Agent Toolkit: create_order, get_order, pay_order
src/store.mjs      requisitions, POs and budgets (JSON file)
data/policy.json   the policy
```

## Limitations

- **Sandbox only.** Payments are captured into the developer's sandbox merchant account, not paid to the real retailer. The listing links go to the real store; in production the PO would be fulfilled from there or through a supplier who accepts PayPal.
- **No login in the demo.** "Requester" and "Approver" are tabs, not authenticated roles. A real deployment would tie the approver tier to the signed-in PayPal or company account.
- **Channel3's catalog is US retail.** It is strong for tools, safety gear and workshop supplies (MRO), weak for niche production components, which is why the demo focuses on MRO.
- The ledger is a JSON file, which is enough for one plant's demo but not for concurrent production use.

## License

[MIT](LICENSE)
