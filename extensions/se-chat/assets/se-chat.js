(() => {
  const root = document.getElementById("se-chat-root");
  if (!root || root.dataset.ready) return;
  root.dataset.ready = "1";

  const launcher = root.querySelector(".se-launcher");
  const panel = root.querySelector(".se-panel");
  const title = root.querySelector("[data-se-title]");
  const back = root.querySelector("[data-se-back]");
  const homeTitle = title.textContent;
  const views = [...root.querySelectorAll("[data-se-view]")];
  let current = "home";

  // Every interaction is published as a Shopify custom event; the app's pixel forwards it
  // (only for visitors who allowed analytics cookies). No personal data is included.
  const track = (action, detail = {}) => {
    try {
      window.Shopify?.analytics?.publish?.("se_chat", { action, view: current, ...detail });
    } catch (_) { /* storage or analytics unavailable */ }
  };

  const store = {
    get: (k) => { try { return sessionStorage.getItem(k); } catch (_) { return null; } },
    set: (k, v) => { try { sessionStorage.setItem(k, v); } catch (_) { /* storage or analytics unavailable */ } },
  };

  function show(view, label) {
    current = view;
    for (const v of views) v.hidden = v.dataset.seView !== view;
    back.hidden = view === "home";
    title.textContent = view === "home" ? homeTitle : label || homeTitle;
    store.set("se-chat-view", view);
  }

  function open(source) {
    panel.hidden = false;
    launcher.setAttribute("aria-expanded", "true");
    store.set("se-chat-open", "1");
    (panel.querySelector(".se-tile, .se-chip") || panel).focus?.();
    track("opened", { source, page: location.pathname });
  }

  function close() {
    panel.hidden = true;
    launcher.setAttribute("aria-expanded", "false");
    store.set("se-chat-open", "0");
    launcher.focus();
    track("closed");
  }

  launcher.addEventListener("click", () => (panel.hidden ? open("launcher") : close()));
  root.querySelector("[data-se-close]").addEventListener("click", close);
  back.addEventListener("click", () => { track("back"); show("home"); });
  document.addEventListener("keydown", (e) => { if (e.key === "Escape" && !panel.hidden) close(); });

  for (const tile of root.querySelectorAll(".se-tile")) {
    tile.addEventListener("click", () => {
      track("menu_clicked", { key: tile.dataset.seKey });
      show(tile.dataset.seGo, tile.textContent.trim());
    });
  }

  const chipsApi = (root.dataset.appUrl || "").replace(/\/$/, "") + "/api/chips";
  const shop = root.dataset.shop;
  const country = root.dataset.country || "";
  const customer = root.dataset.customer || "";
  const currency = root.dataset.currency || "GBP";
  const money = new Intl.NumberFormat("en-GB", { style: "currency", currency });
  const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const results = root.querySelector("[data-se-results]");

  async function loadChip(key, label) {
    results.setAttribute("aria-busy", "true");
    results.innerHTML = '<p class="se-muted">Finding good picks…</p>';
    const url = `${chipsApi}?shop=${encodeURIComponent(shop)}&chip=${encodeURIComponent(key)}&country=${encodeURIComponent(country)}&customer=${encodeURIComponent(customer)}&n=6`;
    try {
      const res = await fetch(url, { credentials: "omit" });
      if (!res.ok) throw new Error(res.status + "");
      const data = await res.json();
      results.setAttribute("aria-busy", "false");
      if (!data.items?.length) {
        results.innerHTML = '<p class="se-muted">Nothing to show for “' + esc(label) + '” right now.</p>';
        return;
      }
      results.innerHTML = data.items.map((it) => {
        const pid = String(it.id).split("/").pop();
        const url = "/products/handle?variant=" + pid;
        const price = money.format(it.price || 0);
        const was = it.wasPrice ? '<span class="se-was">' + money.format(it.wasPrice) + "</span>" : "";
        const why = esc(it.reasonLine || "");
        const pin = it.pinned ? '<span class="se-pin">Pick of the week</span>' : "";
        return (
          '<article class="se-card">' +
          '<a class="se-card-link" href="' + esc(url) + '" data-se-pid="' + esc(it.id) + '" data-se-reason="' + esc(it.reason) + '">' +
          '<h3>' + esc(it.title) + '</h3>' +
          '<p class="se-meta">' + esc([it.vendor, it.region, it.style].filter(Boolean).join(" · ")) + '</p>' +
          '<p class="se-price">' + price + ' ' + was + '</p>' +
          '<p class="se-why">' + why + " " + pin + '</p>' +
          '</a></article>'
        );
      }).join("");
      for (const link of results.querySelectorAll(".se-card-link")) {
        link.addEventListener("click", () => {
          track("product_clicked", { productId: link.dataset.sePid, reason: link.dataset.seReason, chip: key });
        });
      }
      // Fire a product_shown event per card for click-through analysis.
      for (const it of data.items) {
        track("product_shown", { productId: it.id, reason: it.reason, chip: key });
      }
    } catch (e) {
      results.setAttribute("aria-busy", "false");
      results.innerHTML = '<p class="se-muted">Couldn’t load picks. Try again in a moment.</p>';
    }
  }

  for (const chip of root.querySelectorAll(".se-chip")) {
    chip.addEventListener("click", () => {
      for (const c of root.querySelectorAll(".se-chip")) c.setAttribute("aria-pressed", c === chip ? "true" : "false");
      track("chip_clicked", { key: chip.dataset.seKey });
      loadChip(chip.dataset.seKey, chip.textContent.trim());
    });
  }

  root.querySelector("[data-se-form]").addEventListener("submit", (e) => {
    e.preventDefault();
    const input = e.currentTarget.elements.q;
    const q = input.value.trim();
    if (!q) return;
    track("message_sent", { length: q.length }); // the text itself is not tracked
    input.value = "";
  });

  // Reopen where the shopper left off when they move between pages.
  const savedView = store.get("se-chat-view");
  if (savedView && views.some((v) => v.dataset.seView === savedView)) show(savedView);
  if (store.get("se-chat-open") === "1") open("restore");
})();
