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

  for (const chip of root.querySelectorAll(".se-chip")) {
    chip.addEventListener("click", () => {
      for (const c of root.querySelectorAll(".se-chip")) c.setAttribute("aria-pressed", c === chip ? "true" : "false");
      track("chip_clicked", { key: chip.dataset.seKey });
      const results = root.querySelector("[data-se-results]");
      results.innerHTML = "";
      const p = document.createElement("p");
      p.className = "se-muted";
      p.textContent = "Recommendations for “" + chip.textContent.trim() + "” connect in the next build step.";
      results.appendChild(p);
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
