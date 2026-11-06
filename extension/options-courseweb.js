// User-maintained list of UIUC course pages used by the courseweb source.
(function () {
  const form = document.querySelector("#course-websites-form");
  const input = document.querySelector("#course-website-url");
  const list = document.querySelector("#course-websites-list");
  const status = document.querySelector("#course-websites-status");
  if (!form || !input || !list) return;

  function setStatus(message, error = false) {
    if (!status) return;
    status.hidden = !message;
    status.textContent = message || "";
    status.classList.toggle("error", error);
  }

  function normalizeUrl(raw) {
    const adapter = globalThis.PrairieRunCourseWebSource;
    return adapter?.safeCourseUrl?.(raw) || null;
  }

  async function readSettings() {
    const stored = await PrairieRunExt.storageLocalGet("prairierunSettings");
    return stored?.prairierunSettings && typeof stored.prairierunSettings === "object"
      ? stored.prairierunSettings
      : {};
  }

  async function render() {
    const current = await readSettings();
    const sites = Array.isArray(current.courseWebsites) ? current.courseWebsites : [];
    list.textContent = "";
    for (const raw of sites) {
      const url = normalizeUrl(raw);
      if (!url) continue;
      const row = document.createElement("li");
      row.className = "course-website-row";
      const link = document.createElement("a");
      link.href = url;
      link.target = "_blank";
      link.rel = "noreferrer";
      link.textContent = url;
      row.appendChild(link);
      const remove = document.createElement("button");
      remove.type = "button";
      remove.className = "secondary";
      remove.textContent = "Remove";
      remove.setAttribute("aria-label", `Remove ${url}`);
      remove.addEventListener("click", async () => {
        const latest = await readSettings();
        latest.courseWebsites = (latest.courseWebsites || []).map(normalizeUrl).filter((value) => value && value !== url);
        await PrairieRunExt.storageLocalSet({ prairierunSettings: latest });
        setStatus("Course page removed.");
        await render();
      });
      row.appendChild(remove);
      list.appendChild(row);
    }
    if (!list.children.length) setStatus("Add the course pages you want PrairieRun to check. Enable UIUC course websites in Sources to scan them.");
    else if (!status?.classList.contains("error")) setStatus("");
  }

  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    const url = normalizeUrl(input.value);
    if (!url) {
      setStatus("Enter an HTTPS course page on illinois.edu.", true);
      return;
    }
    try {
      const current = await readSettings();
      const sites = (Array.isArray(current.courseWebsites) ? current.courseWebsites : []).map(normalizeUrl).filter(Boolean);
      if (!sites.includes(url)) sites.push(url);
      if (sites.length > 25) {
        setStatus("PrairieRun can scan up to 25 saved course pages.", true);
        return;
      }
      current.courseWebsites = sites;
      await PrairieRunExt.storageLocalSet({ prairierunSettings: current });
      input.value = "";
      setStatus(sites.includes(url) ? "Course page saved. Enable UIUC course websites in Sources, then Sync now." : "Course page saved.");
      await render();
      setStatus("Course page saved. Enable UIUC course websites in Sources, then Sync now.");
    } catch (error) {
      setStatus(error?.message || "Could not save that course page.", true);
    }
  });

  render().catch((error) => setStatus(error?.message || "Could not load saved course pages.", true));
  PrairieRunExt.addStorageChangedListener?.((changes, areaName) => {
    if (areaName === "local" && changes.prairierunSettings) render().catch(() => undefined);
  });
})();
