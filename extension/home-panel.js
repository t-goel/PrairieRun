(function () {
  if (window.PrairieRunHomePanel) return;
  const PANEL_ID = "prairierun-home-panel";
  const SETTINGS_KEY = "prairierunSettings";
  const ASSIGNMENTS_KEY = "prairierunAssignments";
  let assignments = [];
  let settings = { showUndatedAssignments: false, assignmentView: "class" };
  let panel;

  function escapeHtml(value) { return String(value ?? "").replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;"); }
  function dueLabel(item) { return PrairieRunView.formatDueDate(item.dueAtLocal); }
  function visibleAssignments() { return assignments.filter((item) => PrairieRunView.displayable(item, settings.showUndatedAssignments)); }

  function rowMarkup(item, showCourseTag = false) {
    const score = Number(item.score);
    const progress = Number.isFinite(score) ? Math.max(0, Math.min(100, score)) : null;
    const progressBadge = progress === null ? "" : `<span class="prr-progress" aria-label="${progress}% complete"><svg viewBox="0 0 36 36" aria-hidden="true"><circle class="prr-progress__track" cx="18" cy="18" r="15" pathLength="100"></circle><circle class="prr-progress__arc${progress === 0 ? " prr-progress__arc--empty" : ""}" cx="18" cy="18" r="15" pathLength="100" stroke-dasharray="${progress} 100"></circle></svg><span class="prr-progress__value">${Math.round(progress)}</span></span>`;
    return `<li class="list-group-item prr-row">
      <div class="prr-row-main"><div>
        <a href="${escapeHtml(item.sourceUrl)}" target="_blank" rel="noreferrer">${escapeHtml(item.title || "Untitled assignment")}</a>
        <div class="prr-meta text-muted"><span>${escapeHtml(dueLabel(item))}</span>${showCourseTag ? ` <span class="prr-course-tag">${escapeHtml(item.courseName || "Unknown class")}</span>` : ""}</div>
      </div></div>
      <div class="prr-actions">${progressBadge}
        <button type="button" class="btn btn-outline-secondary btn-sm" data-edit-id="${escapeHtml(item.id)}">${item.dueAtLocal ? "Edit date" : "Add date"}</button>
      </div>
    </li>`;
  }

  function listMarkup() {
    const current = visibleAssignments().sort(PrairieRunView.compareAssignments);
    if (!current.length) return `<li class="list-group-item text-muted">No assignments due today or later. Scan PrairieLearn to refresh.</li>`;
    const groups = new Map();
    current.forEach((item) => {
      const key = item.courseInstanceId || item.courseName || "Unknown class";
      if (!groups.has(key)) groups.set(key, { name: item.courseName || key, items: [] });
      groups.get(key).items.push(item);
    });
    const classGroups = [...groups.values()].map((group) => {
      const uncompleted = group.items.filter((item) => !PrairieRunView.isCompleted(item));
      const completed = group.items.filter(PrairieRunView.isCompleted);
      const topThree = uncompleted.filter((item) => item.dueAtLocal).slice(0, 3);
      const overflow = uncompleted.filter((item) => !topThree.includes(item));
      return { ...group, topThree, overflow, completed };
    });
    if (settings.assignmentView === "ordered") {
      const upcoming = classGroups.flatMap((group) => [...group.topThree, ...group.overflow]).sort(PrairieRunView.compareAssignments);
      const completed = classGroups.flatMap((group) => group.completed).sort(PrairieRunView.compareAssignments);
      const completedBlock = completed.length ? `<li class="list-group-item prr-collapsed"><details><summary class="text-muted">Show ${completed.length} completed assignment${completed.length === 1 ? "" : "s"}</summary>${completed.map((item) => rowMarkup(item, true)).join("")}</details></li>` : "";
      return `${upcoming.map((item) => rowMarkup(item, true)).join("")}${completedBlock}`;
    }
    return classGroups.map((group) => {
      const overflowBlock = group.overflow.length ? `<li class="list-group-item prr-collapsed"><details><summary class="text-muted">Show ${group.overflow.length} more upcoming assignment${group.overflow.length === 1 ? "" : "s"}</summary>${group.overflow.map(rowMarkup).join("")}</details></li>` : "";
      const completedBlock = group.completed.length ? `<li class="list-group-item prr-collapsed"><details><summary class="text-muted">Show ${group.completed.length} completed assignment${group.completed.length === 1 ? "" : "s"}</summary>${group.completed.map(rowMarkup).join("")}</details></li>` : "";
      return `<li class="list-group-item prr-group-header">${escapeHtml(group.name)}</li>${group.topThree.map(rowMarkup).join("")}${overflowBlock}${completedBlock}`;
    }).join("");
  }

  function render() {
    if (!panel) return;
    const current = visibleAssignments();
    panel.querySelector(".prr-count").textContent = `${current.length} current assignment${current.length === 1 ? "" : "s"}`;
    const viewToggle = panel.querySelector("#prr-view-toggle");
    viewToggle.classList.toggle("prr-view-switch--ordered", settings.assignmentView === "ordered");
    viewToggle.setAttribute("aria-label", settings.assignmentView === "ordered" ? "Showing assignments by due date" : "Showing assignments by class");
    const undatedButton = panel.querySelector("#prr-show-undated");
    undatedButton.textContent = settings.showUndatedAssignments ? "Hide undated" : "Show undated";
    undatedButton.classList.toggle("prr-toggle--active", settings.showUndatedAssignments === true);
    panel.querySelector(".prr-list").innerHTML = listMarkup();
    panel.querySelectorAll("button[data-edit-id]").forEach((button) => button.addEventListener("click", () => editDueDate(button.dataset.editId)));
  }

  async function persist() { await PrairieRunExt.storageLocalSet({ [ASSIGNMENTS_KEY]: assignments }); render(); }

  async function editDueDate(id) {
    const item = assignments.find((entry) => entry.id === id); if (!item) return;
    const current = item.manuallyEnteredDueAt || item.dueAtLocal || "";
    const normalizedCurrent = current.replace(" ", "T").slice(0, 16);
    const dialog = document.createElement("dialog");
    dialog.className = "prr-date-dialog";
    dialog.innerHTML = `<form method="dialog"><h3>Assignment due date</h3><label>Date <input type="date" name="date" value="${escapeHtml(normalizedCurrent.slice(0, 10))}" /></label><label>Time <input type="time" name="time" value="${escapeHtml(normalizedCurrent.slice(11, 16))}" /></label><div class="prr-dialog-actions"><button value="cancel" class="btn btn-secondary">Cancel</button><button value="remove" class="btn btn-outline-danger">Remove date</button><button value="save" class="btn btn-primary">Save</button></div></form>`;
    document.body.append(dialog);
    dialog.addEventListener("close", async () => {
      if (dialog.returnValue === "save") {
        const date = dialog.querySelector('[name="date"]').value;
        const time = dialog.querySelector('[name="time"]').value;
        if (!date || !time) { dialog.remove(); alert("Choose both a date and time."); return; }
        item.manuallyEnteredDueAt = `${date} ${time}`; item.dueAtLocal = item.manuallyEnteredDueAt; item.syncState = item.syncState === "new" ? "new" : "changed";
      } else if (dialog.returnValue === "remove") { item.manuallyEnteredDueAt = null; item.dueAtLocal = null; }
      dialog.remove();
      if (dialog.returnValue === "save" || dialog.returnValue === "remove") { await persist(); PrairieRunExt.runtimeSendMessage({ type: "PRAIRIERUN_ASSIGNMENT_UPDATED", assignment: item }).catch(() => undefined); }
    });
    dialog.showModal();
  }

  function buildPanel() {
    const built = document.createElement("div");
    built.id = PANEL_ID;
    built.className = "card";
    built.innerHTML = `<div class="card-header bg-primary text-white prr-header">
      <span class="prr-count"></span>
      <div class="prr-header-controls">
        <button type="button" class="btn btn-sm prr-ghost-toggle" id="prr-show-undated">Show undated</button>
        <button type="button" class="prr-view-switch" id="prr-view-toggle" aria-label="Showing assignments by class"><span class="prr-view-switch__tab"></span><span class="prr-view-switch__label prr-view-switch__label--date">Due Date</span><span class="prr-view-switch__label prr-view-switch__label--class">By Class</span></button>
      </div>
    </div>
    <ul class="list-group list-group-flush prr-list"></ul>`;
    built.querySelector("#prr-view-toggle").addEventListener("click", async () => { settings.assignmentView = settings.assignmentView === "ordered" ? "class" : "ordered"; await PrairieRunExt.storageLocalSet({ [SETTINGS_KEY]: settings }); render(); });
    built.querySelector("#prr-show-undated").addEventListener("click", async () => { settings.showUndatedAssignments = !settings.showUndatedAssignments; await PrairieRunExt.storageLocalSet({ [SETTINGS_KEY]: settings }); render(); });
    return built;
  }

  function placePanel() {
    if (document.getElementById(PANEL_ID)) return true;
    const container = document.querySelector('[data-component="HomeCards"]');
    const anchor = container?.querySelector(".card")
      || [...document.querySelectorAll("a[href]")].find((a) => /\/pl\/course_instance\/\d+/.test(a.href))?.closest(".card");
    if (!anchor && !container) return false;
    panel = buildPanel();
    if (anchor?.parentElement) anchor.insertAdjacentElement("afterend", panel);
    else container.append(panel);
    render();
    return true;
  }

  function mount() {
    if (document.getElementById(PANEL_ID)) return;
    PrairieRunExt.storageLocalGet([ASSIGNMENTS_KEY, SETTINGS_KEY]).then((stored) => {
      assignments = stored[ASSIGNMENTS_KEY] || [];
      settings = { ...settings, ...(stored[SETTINGS_KEY] || {}) };
      if (placePanel()) return;
      const observer = new MutationObserver(() => { if (placePanel()) observer.disconnect(); });
      observer.observe(document.body, { childList: true, subtree: true });
      setTimeout(() => observer.disconnect(), 8000);
    });
  }

  function update(nextAssignments) { assignments = nextAssignments || assignments; if (panel) render(); }

  PrairieRunExt.addStorageChangedListener((changes, areaName) => {
    if (areaName !== "local") return;
    if (changes[ASSIGNMENTS_KEY]) assignments = changes[ASSIGNMENTS_KEY].newValue || assignments;
    if (changes[SETTINGS_KEY]) settings = { ...settings, ...(changes[SETTINGS_KEY].newValue || {}) };
    if (changes[ASSIGNMENTS_KEY] || changes[SETTINGS_KEY]) render();
  });

  window.PrairieRunHomePanel = { mount, update };
})();
