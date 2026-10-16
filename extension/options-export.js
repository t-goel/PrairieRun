// PrairieRun export options (PR 8): iCalendar (.ics) download for all
// deadlines or per-source deadlines. Renders into the #export section.
(function () {
  const DEADLINES_KEY = "prairierunDeadlines";
  const SEQUENCES_KEY = "prairierunIcsSequences";
  const SETTINGS_KEY = "prairierunSettings";

  const DEFAULT_SOURCES = [
    { id: "prairielearn", label: "PrairieLearn", defaultEnabled: true },
    { id: "gradescope", label: "Gradescope", defaultEnabled: false },
    { id: "canvas", label: "Canvas", defaultEnabled: false },
    { id: "prairietest", label: "PrairieTest", defaultEnabled: false },
  ];

  function ensureWriterLoaded() {
    if (globalThis.PrairieRunIcsWriter) return Promise.resolve(true);
    if (typeof document === "undefined") return Promise.resolve(false);
    return new Promise((resolve) => {
      const script = document.createElement("script");
      script.src = "ics-writer.js";
      script.onload = () => resolve(Boolean(globalThis.PrairieRunIcsWriter));
      script.onerror = () => resolve(false);
      document.head.append(script);
    });
  }

  function getEnabledSources(settings) {
    if (globalThis.PrairieRunSources?.enabled) {
      return globalThis.PrairieRunSources.enabled(settings).map((a) => ({
        id: a.id,
        label: a.label,
      }));
    }
    const sources = settings?.sources || {};
    return DEFAULT_SOURCES.filter((s) => {
      const entry = sources[s.id];
      if (entry && typeof entry.enabled === "boolean") return entry.enabled;
      return s.defaultEnabled;
    });
  }

  async function downloadIcs(items = [], filename = "prairierun-all.ics", customOpts = {}) {
    await ensureWriterLoaded();
    const writer = globalThis.PrairieRunIcsWriter;
    if (!writer || typeof writer.buildCalendar !== "function") {
      throw new Error("PrairieRunIcsWriter is unavailable.");
    }

    const stored = (await globalThis.PrairieRunExt?.storageLocalGet([
      SEQUENCES_KEY,
      SETTINGS_KEY,
    ])) || {};

    const outputSettings = stored[SETTINGS_KEY]?.output || {};
    const storedSequences = stored[SEQUENCES_KEY] || {};

    const baseName = filename.replace(/\.ics$/i, "") || "PrairieRun";
    const opts = {
      name: baseName,
      now: new Date(),
      sequences: storedSequences,
      eventShape: outputSettings.eventShape || "block1h",
      leadMinutes: outputSettings.leadMinutes !== undefined ? outputSettings.leadMinutes : 240,
      nightBefore: Boolean(outputSettings.nightBefore),
      nightBeforeHour: outputSettings.nightBeforeHour != null ? outputSettings.nightBeforeHour : 20,
      includeCompleted: outputSettings.includeCompleted !== false,
      windowDays: outputSettings.windowDays ?? null,
      ...customOpts,
    };

    const { text, sequences } = writer.buildCalendar(items, opts);

    if (globalThis.PrairieRunExt?.storageLocalSet) {
      await globalThis.PrairieRunExt.storageLocalSet({
        [SEQUENCES_KEY]: sequences,
      });
    }

    if (typeof document !== "undefined" && typeof Blob !== "undefined" && typeof URL !== "undefined") {
      const blob = new Blob([text], { type: "text/calendar;charset=utf-8" });
      const blobUrl = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = blobUrl;
      link.download = filename;
      document.body.appendChild(link);
      link.click();
      setTimeout(() => {
        link.remove();
        URL.revokeObjectURL(blobUrl);
      }, 1000);
    }

    return { text, sequences };
  }

  async function render(section) {
    if (!section || typeof document === "undefined") return;
    if (section.querySelector("[data-prr-export]")) return;

    // Clear PR 1 "Coming soon" note
    for (const note of section.querySelectorAll("p.muted")) {
      if (/coming soon/i.test(note.textContent || "")) note.remove();
    }

    const root = document.createElement("div");
    root.dataset.prrExport = "1";
    section.appendChild(root);

    const writerReady = await ensureWriterLoaded();
    if (!writerReady) {
      const note = document.createElement("p");
      note.className = "muted";
      note.textContent = "iCal export is unavailable (ics-writer module not loaded).";
      root.appendChild(note);
      return;
    }

    async function refresh() {
      root.textContent = "";

      const stored = (await globalThis.PrairieRunExt?.storageLocalGet([
        DEADLINES_KEY,
        SETTINGS_KEY,
      ])) || {};

      const items = Array.isArray(stored[DEADLINES_KEY]) ? stored[DEADLINES_KEY] : [];
      const settings = stored[SETTINGS_KEY] || {};

      const desc = document.createElement("p");
      desc.className = "muted";
      desc.textContent = "Download your assignments and exams as an iCalendar (.ics) file for Apple Calendar, Outlook, or Google Calendar.";
      root.appendChild(desc);

      const btnContainer = document.createElement("div");
      btnContainer.className = "prr-export-buttons";
      btnContainer.style.display = "flex";
      btnContainer.style.flexWrap = "wrap";
      btnContainer.style.gap = "8px";
      btnContainer.style.marginTop = "12px";

      // "Download all (.ics)" button
      const allBtn = document.createElement("button");
      allBtn.type = "button";
      allBtn.id = "export-all-ics";
      allBtn.textContent = "Download all (.ics)";
      allBtn.addEventListener("click", async () => {
        allBtn.disabled = true;
        try {
          await downloadIcs(items, "prairierun-all.ics");
        } finally {
          allBtn.disabled = false;
        }
      });
      btnContainer.appendChild(allBtn);

      // One button per enabled source
      const enabledSources = getEnabledSources(settings);
      for (const source of enabledSources) {
        const sourceItems = items.filter((item) => item?.source === source.id);
        const sourceBtn = document.createElement("button");
        sourceBtn.type = "button";
        sourceBtn.id = `export-${source.id}-ics`;
        sourceBtn.textContent = `Download ${source.label} (.ics)`;
        sourceBtn.addEventListener("click", async () => {
          sourceBtn.disabled = true;
          try {
            await downloadIcs(sourceItems, `prairierun-${source.id}.ics`);
          } finally {
            sourceBtn.disabled = false;
          }
        });
        btnContainer.appendChild(sourceBtn);
      }

      root.appendChild(btnContainer);
    }

    try {
      await refresh();
    } catch (err) {
      root.textContent = "";
      const errNote = document.createElement("p");
      errNote.className = "muted";
      errNote.textContent = `Could not load export: ${err?.message || err}`;
      root.appendChild(errNote);
    }
  }

  if (typeof document !== "undefined") {
    document.addEventListener("DOMContentLoaded", () => {
      const section = document.getElementById("export");
      if (section) render(section);
    });
  }

  const api = { render, downloadIcs };
  globalThis.PrairieRunOptionsExport = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})();
