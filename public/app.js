// Procure Agent UI: requester form with a live agent trace, approver inbox with PayPal buttons, ledger.
const $ = (sel) => document.querySelector(sel);
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const money = (n) => `$${Number(n).toFixed(2)}`;

const EXAMPLES = [
  { cc: "LINE-2-MAINT", text: "Line 2 needs 2 temperature-controlled soldering stations for rework, 60-80W, ideally under $100 each. Needed this week." },
  { cc: "EHS", text: "EHS needs 10 ear muffs, NRR 23 or higher, for the operators next to the press line." },
  { cc: "QA-LAB", text: "QA lab needs 3 desktop anti-static (ESD) mats with grounding cords for the inspection benches." },
  { cc: "QA-LAB", text: "QA lab needs 3 ESD wrist straps with grounding cords for the new inspectors, under $10 each." },
  { cc: "LINE-2-MAINT", text: "Buy 15 cordless drills for the whole maintenance team, the best ones available." },
];

let config = null;
let paypalReady = null;

// ---------- tabs ----------
function showTab(name) {
  document.querySelectorAll(".tabs button").forEach((b) => b.setAttribute("aria-selected", String(b.dataset.tab === name)));
  document.querySelectorAll(".tab").forEach((t) => { t.hidden = t.id !== `tab-${name}`; });
  if (name === "approvals") renderApprovals();
  if (name === "orders") renderLedger();
}
document.querySelectorAll(".tabs button").forEach((b) => b.addEventListener("click", () => showTab(b.dataset.tab)));

// ---------- boot ----------
async function boot() {
  config = await (await fetch("/api/config")).json();
  $("#env").textContent = `PayPal ${config.paypal_env}`;
  $("#costCenter").innerHTML = config.policy.cost_centers.map((c) => `<option value="${esc(c.id)}">${esc(c.name)} (${esc(c.id)})</option>`).join("");
  $("#modeHint").textContent = config.agent === "gemini" ? `Agent: ${config.model}` : "Agent: scripted playbook (no model key)";
  $("#examples").innerHTML = EXAMPLES.map((e, i) => `<button type="button" data-i="${i}">${esc(e.text.length > 64 ? `${e.text.slice(0, 61)}...` : e.text)}</button>`).join("");
  $("#examples").addEventListener("click", (ev) => {
    const b = ev.target.closest("button[data-i]");
    if (!b) return;
    const e = EXAMPLES[Number(b.dataset.i)];
    $("#text").value = e.text;
    $("#costCenter").value = e.cc;
    fitText();
    setExamples(false);
  });
  $("#toggleExamples").addEventListener("click", () => setExamples($("#examples").hidden));
  $("#text").addEventListener("input", fitText);
  $("#policyText").innerHTML = policyHtml(config.policy);
  $("#reset").hidden = !config.allow_reset;
  refreshCount();
  const q = new URLSearchParams(location.search);
  if (q.get("wallet") === "approved") {
    history.replaceState(null, "", "/");
    showTab("approvals");
    const id = q.get("approval_token_id") || q.get("approval_session_id") || q.get("token");
    const res = await fetch("/api/wallet/confirm", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ setup_token_id: id }) });
    const out = await res.json();
    renderWallet(res.ok ? null : out.error);
  } else if (q.get("wallet") === "cancelled") {
    history.replaceState(null, "", "/");
    showTab("approvals");
    renderWallet("Authorization cancelled in PayPal; the agent wallet was not set up.");
  } else if (q.has("approved") || q.has("cancelled")) showTab("approvals");
}

function setExamples(show) {
  $("#examples").hidden = !show;
  $("#toggleExamples").textContent = show ? "Hide examples" : "Show examples";
  $("#toggleExamples").setAttribute("aria-expanded", String(show));
}

// Grow the request box to fit its text, so a picked example is readable in full.
function fitText() {
  const t = $("#text");
  t.style.height = "auto";
  t.style.height = `${t.scrollHeight + 2}px`;
}

function policyHtml(p) {
  return `<ul>
    <li>One order at most <b>${money(p.hard_limit_per_order)}</b>; larger buys go to a formal RFQ.</li>
    <li>Unit price at most ${money(p.max_unit_price)}; 1-${p.max_quantity_per_line} units per line; ${p.require_in_stock ? "in-stock listings only" : "stock not checked"}.</li>
    <li>Approval: ${p.approval_tiers.map((t) => `up to ${money(t.max_total)} → ${esc(t.approver)}`).join("; ")}.</li>
    <li>Approved retailers: ${p.approved_retailers.map(esc).join(", ")}.</li>
    <li>Restricted: ${p.blocked_keywords.map(esc).join(", ")}.</li>
    <li>Monthly budgets: ${p.cost_centers.map((c) => `${esc(c.name)} ${money(c.monthly_budget)}`).join("; ")}.</li>
  </ul>`;
}

// ---------- requester ----------
const TOOL_LABEL = {
  search_catalog: (i) => `Searching Channel3 for “${esc(i.query)}”${i.max_unit_price ? ` (≤ ${money(i.max_unit_price)})` : ""}`,
  check_policy: (i) => `Checking the spend policy on ${(i.lines ?? []).map((l) => `${l.quantity} × ${esc(l.ref)}`).join(", ")}`,
  submit_requisition: () => "Submitting the requisition and creating the PayPal order",
  decline_request: () => "Declining: this cannot be bought within policy",
};

let chosenRefs = new Set();
let lastRun = null;

function productCard(p, { chosen = false, off = false } = {}) {
  return `<div class="prod${chosen ? " chosen" : ""}${off ? " off" : ""}" data-ref="${esc(p.ref)}">
    ${p.image ? `<img src="${esc(p.image)}" alt="" loading="lazy">` : ""}
    <span class="ref">${esc(p.ref ?? "")} · ${esc(p.retailer ?? "?")}</span>
    <span class="t">${esc(p.title)}</span>
    <span class="p">${money(p.price)} <span class="pill ${p.approved_retailer ? "ok" : "bad"}">${p.approved_retailer ? "approved retailer" : "not approved"}</span></span>
    ${p.url ? `<a href="${esc(p.url)}" target="_blank" rel="noopener">listing ↗</a>` : ""}
  </div>`;
}

function requirementsHtml(reqs) {
  return reqs?.length ? `<div class="reqs"><span class="hint">Must-haves the agent checked:</span> ${reqs.map((x) => `<span class="pill">${esc(x)}</span>`).join(" ")}</div>` : "";
}

const covers = (l) => (l.units_covered && l.units_covered !== l.quantity ? ` · covers ${esc(l.units_covered)} units` : "");

function checksHtml(checks, warnings = []) {
  return `<ul class="checks">${checks.map((c) => `<li class="${c.pass ? "pass" : "failc"}"><b>${esc(c.rule)}</b>: ${esc(c.detail)}</li>`).join("")}${warnings.map((w) => `<li class="warnc"><b>${esc(w.rule)}</b>: ${esc(w.detail)}</li>`).join("")}</ul>`;
}

const warningBanner = (warnings, why) => (warnings?.length
  ? `<div class="warnbox">⚠ ${warnings.map((w) => esc(w.detail)).join("<br>⚠ ")}${why ? `<br><b>Requester's reason:</b> “${esc(why)}”` : ""}</div>`
  : "");

function policyCard(v) {
  const head = v.verdict === "blocked"
    ? `<span class="pill bad">blocked by policy</span>`
    : `<span class="pill ok">within policy</span> needs <b>${esc(v.approver)}</b>`;
  return `<div class="card"><div class="verdict"><h2>${v.draft ? "Policy check (draft)" : "Policy check (final)"}</h2><span>${head}</span></div>
    <div class="big">${money(v.total)}</div>${checksHtml(v.checks, v.warnings)}</div>`;
}

function requisitionCard(r) {
  if (r.auto_paid) {
    return `<div class="card">
      <div class="verdict"><h2>${esc(r.po_number)} paid by the agent wallet</h2><span class="pill ok">no approval needed</span></div>
      <p>${esc(r.summary)}</p>
      ${requirementsHtml(r.requirements)}
      <table class="lines">${r.lines.map((l) => `<tr><td>${esc(l.quantity)} ×</td><td>${esc(l.product.title)}<br><span class="ref">${esc(l.product.retailer)} · ${money(l.product.price)} each${covers(l)}</span></td><td class="num">${money(l.line_total)}</td></tr>`).join("")}
        <tr><td></td><td><b>Total</b></td><td class="num"><b>${money(r.total)}</b></td></tr></table>
      <div class="okbox">Within the wallet limit and every policy check passed, so the agent paid with the PayPal wallet ${esc(r.approved_by?.replace("Agent wallet ", "") ?? "")}. PayPal capture <span class="mono">${esc(r.capture_id)}</span>.</div>
    </div>`;
  }
  return `<div class="card">
    <div class="verdict"><h2>${esc(r.id)} routed for approval</h2><span class="pill ok">awaiting ${esc(r.approver)}</span></div>
    <p>${esc(r.summary)}</p>
    ${warningBanner(r.warnings, r.duplicate_justification)}
    ${requirementsHtml(r.requirements)}
    <table class="lines">${r.lines.map((l) => `<tr><td>${esc(l.quantity)} ×</td><td>${esc(l.product.title)}<br><span class="ref">${esc(l.product.retailer)} · ${money(l.product.price)} each${covers(l)}</span><br><span class="ref">${esc(l.reason ?? "")}</span></td><td class="num">${money(l.line_total)}</td></tr>`).join("")}
      <tr><td></td><td><b>Total</b></td><td class="num"><b>${money(r.total)}</b></td></tr></table>
    ${r.compared?.length ? `<details><summary>Also compared (${r.compared.length})</summary><ul class="compared">${r.compared.map((c) => `<li><b>${esc(c.ref)}</b> ${esc(c.product.title)} (${money(c.product.price)}, ${esc(c.product.retailer)}): ${esc(c.note)}</li>`).join("")}</ul></details>` : ""}
    <p class="hint">PayPal order <span class="mono">${esc(r.paypal_order_id)}</span> created; no money moves until the approver confirms in PayPal.</p>
    <button type="button" class="primary" data-goto="approvals">Open the approval as ${esc(r.approver)}</button>
  </div>`;
}

$("#requestForm").addEventListener("submit", async (ev) => {
  ev.preventDefault();
  const text = $("#text").value.trim();
  if (!text) return $("#text").focus();
  $("#go").disabled = true;
  setExamples(false);
  $("#run").hidden = false;
  $("#run").scrollIntoView({ behavior: "smooth", block: "start" });
  for (const id of ["#steps", "#searches", "#policyBox", "#outcome"]) $(id).innerHTML = "";
  chosenRefs = new Set();
  lastRun = { results: new Map() };

  const stepEls = new Map();
  const addStep = (html, cls = "") => { const li = document.createElement("li"); li.className = cls; li.innerHTML = html; $("#steps").append(li); return li; };

  try {
    const res = await fetch("/api/requests", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text, requester: $("#requester").value, cost_center: $("#costCenter").value }),
    });
    if (!res.ok || !res.body) throw new Error((await res.json().catch(() => ({}))).error || `Request failed (${res.status})`);
    const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
    let buf = "";
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += value;
      let idx;
      while ((idx = buf.indexOf("\n\n")) >= 0) {
        const chunk = buf.slice(0, idx);
        buf = buf.slice(idx + 2);
        const ev = chunk.match(/^event: (.*)$/m)?.[1];
        const data = JSON.parse(chunk.match(/^data: (.*)$/m)?.[1] ?? "null");
        handleEvent(ev, data, { addStep, stepEls });
      }
    }
  } catch (err) {
    $("#outcome").innerHTML = `<div class="err">${esc(err.message)}</div>`;
  } finally {
    $("#go").disabled = false;
    refreshCount();
  }
});

function handleEvent(ev, d, { addStep, stepEls }) {
  switch (ev) {
    case "start": addStep(d.mode === "gemini" ? `Agent started (${esc(d.model)})` : "Agent started (scripted)", "done"); break;
    case "note": addStep(esc(d.text), "note"); break;
    case "step": stepEls.set(d.id, addStep((TOOL_LABEL[d.tool] ?? (() => esc(d.tool)))(d.input ?? {}))); break;
    case "step_done": stepEls.get(d.id)?.classList.add(d.ok ? "done" : "fail"); break;
    case "results": {
      for (const p of d.results) lastRun.results.set(p.ref, p);
      const div = document.createElement("div");
      div.className = "card";
      div.innerHTML = `<h2>Channel3 results: “${esc(d.query)}”</h2>${d.results.length ? `<div class="grid">${d.results.map((p) => productCard(p)).join("")}</div>` : `<p class="hint">No in-stock listings.</p>`}`;
      $("#searches").append(div);
      break;
    }
    case "policy": $("#policyBox").innerHTML = policyCard(d); break;
    case "requisition":
      for (const l of d.lines) chosenRefs.add(l.ref);
      document.querySelectorAll("#searches .prod").forEach((el) => el.classList.toggle("chosen", chosenRefs.has(el.dataset.ref)));
      $("#outcome").innerHTML = requisitionCard(d);
      break;
    case "declined":
      $("#outcome").innerHTML = `<div class="card"><div class="verdict"><h2>Not ordered</h2><span class="pill bad">declined</span></div><p>${esc(d.reason)}</p><p><b>Next step:</b> ${esc(d.next_step)}</p></div>`;
      break;
    case "error": $("#outcome").innerHTML = `<div class="err">${esc(d.message)}</div>`; break;
    case "done": addStep("Done", "done"); break;
  }
}

$("#outcome").addEventListener("click", (ev) => { if (ev.target.closest("[data-goto]")) showTab("approvals"); });

// ---------- approver ----------
function loadPayPal() {
  if (paypalReady) return paypalReady;
  paypalReady = new Promise((resolve, reject) => {
    const s = document.createElement("script");
    s.src = `https://www.paypal.com/sdk/js?client-id=${encodeURIComponent(config.paypal_client_id)}&currency=USD&intent=capture&components=buttons`;
    s.onload = () => resolve(window.paypal);
    s.onerror = () => { paypalReady = null; reject(new Error("Could not load PayPal checkout.")); };
    document.head.append(s);
  });
  return paypalReady;
}

async function refreshCount() {
  const list = await (await fetch("/api/requisitions")).json();
  const n = list.filter((r) => r.status === "awaiting_approval").length;
  $("#approvalCount").hidden = !n;
  $("#approvalCount").textContent = n;
  return list;
}

async function renderWallet(message) {
  const w = await (await fetch("/api/wallet")).json();
  const box = $("#wallet");
  const note = message ? `<div class="err">${esc(message)}</div>` : "";
  box.innerHTML = w.authorized
    ? `${note}<div class="verdict"><h2>Agent wallet</h2><span class="pill ok">authorized</span></div>
       <p>The agent pays orders up to <b>${money(w.max_order_total)}</b> that pass every policy check with no warnings, at most ${money(w.max_per_day)} a day, from the PayPal wallet of <b>${esc(w.authorized_by)}</b>${w.payer_email ? ` (${esc(w.payer_email)})` : ""}. Paid today: ${money(w.spent_today)}.</p>
       <button type="button" class="secondary" id="revokeWallet">Revoke in PayPal</button>`
    : `${note}<div class="verdict"><h2>Agent wallet</h2><span class="pill bad">not authorized</span></div>
       <p>Let the agent pay small, compliant orders (up to ${money(w.max_order_total)}, at most ${money(w.max_per_day)} a day) without waiting for you. You approve once in PayPal and can revoke at any time; everything larger still comes here.</p>
       <button type="button" class="primary" id="authorizeWallet">Authorize with PayPal</button>`;
}

$("#wallet").addEventListener("click", async (ev) => {
  if (ev.target.id === "authorizeWallet") {
    ev.target.disabled = true;
    const res = await fetch("/api/wallet/setup", { method: "POST" });
    const out = await res.json();
    if (!res.ok || !out.approve_url) { ev.target.disabled = false; return renderWallet(out.error ?? "PayPal did not return an approval link."); }
    location.href = out.approve_url;
  }
  if (ev.target.id === "revokeWallet") {
    if (!confirm("Revoke the agent wallet? Small orders will need approval again.")) return;
    await fetch("/api/wallet/revoke", { method: "POST" });
    renderWallet();
  }
});

async function renderApprovals() {
  renderWallet();
  const list = (await refreshCount()).filter((r) => r.status === "awaiting_approval");
  const box = $("#approvals");
  if (!list.length) { box.innerHTML = `<div class="card"><p class="hint">Nothing waiting for approval.</p></div>`; return; }
  box.innerHTML = list.map((r) => `<div class="card approval" id="ap-${esc(r.id)}">
    <div class="verdict"><h2>${esc(r.id)} · ${money(r.total)}</h2><span class="pill ok">needs ${esc(r.approver)}</span></div>
    <div class="meta">${esc(r.requester)} · ${esc(r.cost_center)} · ${new Date(r.created_at).toLocaleString()}</div>
    <p class="meta">“${esc(r.request_text)}”</p>
    <p>${esc(r.summary)}</p>
    ${warningBanner(r.warnings, r.duplicate_justification)}
    ${requirementsHtml(r.requirements)}
    <table class="lines">${r.lines.map((l) => `<tr><td>${esc(l.quantity)} ×</td><td><a href="${esc(l.product.url)}" target="_blank" rel="noopener">${esc(l.product.title)}</a><br><span class="ref">${esc(l.product.retailer)} · ${money(l.product.price)} each${covers(l)}</span>${l.reason ? `<br><span class="ref">${esc(l.reason)}</span>` : ""}</td><td class="num">${money(l.line_total)}</td></tr>`).join("")}</table>
    <details><summary>Policy checks (${r.checks.filter((c) => c.pass).length}/${r.checks.length} pass${r.warnings?.length ? `, ${r.warnings.length} warning` : ""})</summary>${checksHtml(r.checks, r.warnings)}</details>
    <div class="buttons"><div class="pp" id="pp-${esc(r.id)}"></div><button type="button" class="secondary" data-reject="${esc(r.id)}">Reject</button></div>
    <div class="msg"></div>
  </div>`).join("");

  try {
    const paypal = await loadPayPal();
    for (const r of list) {
      paypal.Buttons({
        style: { layout: "vertical", label: "pay", tagline: false },
        createOrder: () => r.paypal_order_id,
        onApprove: async (data) => {
          const msg = $(`#ap-${r.id} .msg`);
          msg.innerHTML = `<p class="hint">Capturing payment…</p>`;
          const res = await fetch(`/api/requisitions/${r.id}/capture`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ order_id: data.orderID }) });
          const out = await res.json();
          if (!res.ok) { msg.innerHTML = `<div class="err">${esc(out.error)}</div>`; return; }
          $(`#ap-${r.id}`).innerHTML = `<div class="okbox"><b>${esc(out.po_number)}</b> issued for ${esc(out.id)}: ${money(out.total)} captured in PayPal (capture <span class="mono">${esc(out.capture_id)}</span>), approved by ${esc(out.approved_by)}.</div>`;
          refreshCount();
        },
        onCancel: () => { $(`#ap-${r.id} .msg`).innerHTML = `<p class="hint">Approval cancelled in PayPal; the requisition is still waiting.</p>`; },
        onError: (err) => { $(`#ap-${r.id} .msg`).innerHTML = `<div class="err">PayPal error: ${esc(err?.message ?? err)}</div>`; },
      }).render(`#pp-${r.id}`);
    }
  } catch (err) {
    box.insertAdjacentHTML("afterbegin", `<div class="err">${esc(err.message)}</div>`);
  }
}

$("#approvals").addEventListener("click", async (ev) => {
  const b = ev.target.closest("[data-reject]");
  if (!b) return;
  const reason = prompt("Reason for rejecting?", "Please use the existing stock first.");
  if (reason === null) return;
  const res = await fetch(`/api/requisitions/${b.dataset.reject}/reject`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ reason }) });
  if (res.ok) renderApprovals();
});

// ---------- ledger ----------
async function renderLedger() {
  const [budgets, list] = await Promise.all([(await fetch("/api/budgets")).json(), refreshCount()]);
  $("#budgets").innerHTML = budgets.map((b) => {
    const pct = (x) => Math.min(100, (x / b.monthly_budget) * 100);
    return `<div class="card"><h2>${esc(b.name)}</h2>
      <div class="bar"><div class="s" style="width:${pct(b.spent)}%"></div><div class="c" style="width:${pct(b.committed)}%"></div></div>
      <div class="hint">${money(b.spent)} spent · ${money(b.committed)} awaiting · <b>${money(b.available)}</b> of ${money(b.monthly_budget)} left</div></div>`;
  }).join("");
  $("#ledger tbody").innerHTML = list.length ? list.map((r) => `<tr>
    <td><b>${esc(r.po_number ?? r.id)}</b>${r.po_number ? `<br><span class="ref">${esc(r.id)}</span>` : ""}</td>
    <td><span class="status ${esc(r.status)}">${esc(r.status.replace("_", " "))}</span>${r.auto_paid ? `<br><span class="ref">agent wallet</span>` : ""}${r.reject_reason ? `<br><span class="ref">${esc(r.reject_reason)}</span>` : ""}</td>
    <td>${esc(r.cost_center)}</td>
    <td>${r.lines.map((l) => `${esc(l.quantity)} × ${esc(l.product.title)}`).join("<br>")}</td>
    <td class="num">${money(r.total)}</td>
    <td class="mono">${esc(r.capture_id ?? r.paypal_order_id ?? "")}</td></tr>`).join("") : `<tr><td colspan="6" class="hint">No requisitions yet.</td></tr>`;
}

$("#reset").addEventListener("click", async () => {
  if (!confirm("Clear all demo requisitions and purchase orders?")) return;
  await fetch("/api/reset", { method: "POST" });
  renderLedger();
});

boot();
