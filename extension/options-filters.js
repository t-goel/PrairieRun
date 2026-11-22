// Filter card for user-defined keyword filters.
// Assignments whose titles contain any active keyword are excluded from the digest
// and hidden from calendar sync (Google Calendar and ICS feeds).
(function () {
  const SETTINGS_KEY = "prairierunSettings";
  const KEYWORD_FILTERS_KEY = "prairierunKeywordFilters";

  function ext() {
    return globalThis.PrairieRunExt || {};
  }

  function normalizeKeyword(raw) {
    return String(raw || "").trim();
  }

  function matchesKeywords(title, keywords) {
    if (!title || !Array.isArray(keywords) || !keywords.length) return false;
    const lower = String(title).toLowerCase();
    const alpha = lower.replace(/[^a-z0-9]/g, "");
    return keywords.some((kw) => {
      const k = String(kw || "").toLowerCase().trim();
      if (!k) return false;
      if (lower.includes(k)) return true;
      const kAlpha = k.replace(/[^a-z0-9]/g, "");
      if (kAlpha.length >= 2 && alpha.includes(kAlpha)) return true;
      return false;
    });
  }

  async function readKeywords() {
    try {
      const stored = await ext().storageLocalGet?.([SETTINGS_KEY, KEYWORD_FILTERS_KEY]);
      const fromSettings = stored?.[SETTINGS_KEY]?.keywordFilters;
      const fromKey = stored?.[KEYWORD_FILTERS_KEY];
      const source = Array.isArray(fromKey) ? fromKey : (Array.isArray(fromSettings) ? fromSettings : []);
      return source.map(normalizeKeyword).filter(Boolean);
    } catch {
      return [];
    }
  }

  async function saveKeywords(keywords) {
    const clean = Array.from(new Set(keywords.map(normalizeKeyword).filter(Boolean)));
    try {
      const stored = await ext().storageLocalGet?.(SETTINGS_KEY);
      const settings = stored?.[SETTINGS_KEY] && typeof stored[SETTINGS_KEY] === "object"
        ? stored[SETTINGS_KEY]
        : {};
      settings.keywordFilters = clean;
      await ext().storageLocalSet?.({
        [SETTINGS_KEY]: settings,
        [KEYWORD_FILTERS_KEY]: clean,
      });
      try {
        await ext().runtimeSendMessage?.({
          type: "PRAIRIERUN_KEYWORD_FILTERS_CHANGED",
          keywords: clean,
        });
      } catch {
        /* best effort */
      }
    } catch (error) {
      console.error("Failed to save keyword filters", error);
    }
    return clean;
  }

  function dispatchFiltersChanged(keywords) {
    if (typeof document === "undefined" || typeof document.dispatchEvent !== "function") return;
    try {
      if (typeof window !== "undefined" && typeof window.CustomEvent === "function") {
        document.dispatchEvent(new window.CustomEvent("prairierun-filters-changed", { detail: { keywords } }));
        return;
      }
      if (document.defaultView && typeof document.defaultView.CustomEvent === "function") {
        document.dispatchEvent(new document.defaultView.CustomEvent("prairierun-filters-changed", { detail: { keywords } }));
        return;
      }
      const ev = document.createEvent ? document.createEvent("Event") : null;
      if (ev && ev.initEvent) {
        ev.initEvent("prairierun-filters-changed", true, true);
        document.dispatchEvent(ev);
      }
    } catch {
      /* best effort */
    }
  }

  function createChip(keyword, onRemove) {
    const chip = document.createElement("span");
    chip.className = "prr-chip";
    chip.dataset.keyword = keyword;

    const text = document.createElement("span");
    text.className = "prr-chip-text";
    text.textContent = keyword;
    chip.appendChild(text);

    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "prr-chip-remove";
    btn.textContent = "×";
    btn.setAttribute("aria-label", `Remove filter "${keyword}"`);
    btn.addEventListener("click", (event) => {
      event.stopPropagation();
      if (typeof onRemove === "function") {
        onRemove(keyword);
      }
    });
    chip.appendChild(btn);

    return chip;
  }

  function initFiltersCard(root = document) {
    const box = root.querySelector("#filter-chips-box");
    const list = root.querySelector("#filter-chips-list");
    const input = root.querySelector("#filter-keyword-input");
    const status = root.querySelector("#filter-status");

    if (!box || !list || !input) return null;

    let currentKeywords = [];

    function updatePlaceholder() {
      input.placeholder = currentKeywords.length ? "Add keyword…" : "Type keyword and press Enter…";
    }

    function render() {
      list.textContent = "";
      for (const kw of currentKeywords) {
        const chip = createChip(kw, async (removedKw) => {
          currentKeywords = currentKeywords.filter((k) => k.toLowerCase() !== removedKw.toLowerCase());
          render();
          dispatchFiltersChanged(currentKeywords);
          await saveKeywords(currentKeywords);
          input.focus();
        });
        list.appendChild(chip);
      }
      updatePlaceholder();
    }

    // Clicking anywhere in the box focuses the input
    box.addEventListener("click", (event) => {
      if (!event.target.closest(".prr-chip-remove")) {
        input.focus();
      }
    });

    input.addEventListener("keydown", async (event) => {
      if (event.key === "Enter") {
        event.preventDefault();
        event.stopPropagation();
        const raw = input.value.trim();
        input.value = "";
        if (!raw) return;
        const exists = currentKeywords.some((k) => k.toLowerCase() === raw.toLowerCase());
        if (!exists) {
          currentKeywords.push(raw);
          render();
          dispatchFiltersChanged(currentKeywords);
          await saveKeywords(currentKeywords);
        }
        return;
      }

      if (event.key === "Backspace") {
        const hasNoText = input.value === "" || (input.selectionStart === 0 && input.selectionEnd === 0 && input.value.length === 0);
        if (hasNoText && currentKeywords.length > 0) {
          event.preventDefault();
          currentKeywords.pop();
          render();
          dispatchFiltersChanged(currentKeywords);
          await saveKeywords(currentKeywords);
        }
      }
    });

    input.addEventListener("keyup", (event) => {
      if (event.key === "Enter") {
        event.preventDefault();
        input.value = "";
      }
    });

    readKeywords().then((keywords) => {
      currentKeywords = keywords;
      render();
    }).catch(() => undefined);

    ext().addStorageChangedListener?.((changes, area) => {
      if (area === "local" && (changes[KEYWORD_FILTERS_KEY] || changes[SETTINGS_KEY])) {
        readKeywords().then((keywords) => {
          currentKeywords = keywords;
          render();
        }).catch(() => undefined);
      }
    });

    return {
      render,
      getKeywords: () => [...currentKeywords],
      setKeywords: async (kw) => {
        currentKeywords = [...kw];
        await saveKeywords(currentKeywords);
        render();
      },
    };
  }

  // Auto-initialize when document is ready
  if (typeof document !== "undefined") {
    if (document.readyState === "loading") {
      document.addEventListener("DOMContentLoaded", () => initFiltersCard());
    } else {
      initFiltersCard();
    }
  }

  const api = {
    normalizeKeyword,
    matchesKeywords,
    readKeywords,
    saveKeywords,
    createChip,
    initFiltersCard,
  };

  globalThis.PrairieRunFilters = api;
  if (typeof module !== "undefined" && module.exports) {
    module.exports = api;
  }
})();
