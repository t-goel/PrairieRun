(function () {
  if (window.PrairieRunHomePanel) return;
  const PANEL_ID = "prairierun-home-panel";
  const SETTINGS_KEY = "prairierunSettings";
  const ASSIGNMENTS_KEY = "prairierunAssignments";
  const DEADLINES_KEY = "prairierunDeadlines";
  let assignments = [];
  let deadlineMode = false;
  let settings = { showUndatedAssignments: false, assignmentView: "class" };
  let panel;

  function escapeHtml(value) { return String(value ?? "").replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;"); }
  function dueLabel(item) { return PrairieRunView.formatItemDue(item); }
  function visibleAssignments() { return assignments.filter((item) => PrairieRunView.displayable(item, settings.showUndatedAssignments)); }

  function rowMarkup(item, showCourseTag = false) {
    const score = Number(item.score);
    const progress = Number.isFinite(score) ? Math.max(0, Math.min(100, score)) : null;
    const progressBadge = progress === null ? "" : `<span class="prr-progress" aria-label="${progress}% complete"><svg viewBox="0 0 36 36" aria-hidden="true"><circle class="prr-progress__track" cx="18" cy="18" r="15" pathLength="100"></circle><circle class="prr-progress__arc${progress === 0 ? " prr-progress__arc--empty" : ""}" cx="18" cy="18" r="15" pathLength="100" stroke-dasharray="${progress} 100"></circle></svg><span class="prr-progress__value">${Math.round(progress)}</span></span>`;
    const badge = PrairieRunView.sourceBadge(item);
    const badgeHtml = badge ? `<span class="prr-badge" title="${escapeHtml(sourceTitle(item))}">${escapeHtml(badge)}</span>` : "";
    const locationHtml = item?.kind === "exam" && item?.location ? ` <span class="prr-location">${escapeHtml(item.location)}</span>` : "";
    const editHtml = PrairieRunView.canEditDate(item)
      ? `<button type="button" class="btn btn-outline-secondary btn-sm" data-edit-id="${escapeHtml(item.id)}">${PrairieRunView.dueDateKey(item) ? "Edit date" : "Add date"}</button>`
      : "";
    return `<li class="list-group-item prr-row">
      <div class="prr-row-main"><div>
        <a href="${escapeHtml(PrairieRunView.itemUrl(item))}" target="_blank" rel="noreferrer">${escapeHtml(item.title || "Untitled assignment")}</a>
        <div class="prr-meta text-muted">${badgeHtml}<span>${escapeHtml(dueLabel(item))}</span>${locationHtml}${showCourseTag ? ` <span class="prr-course-tag">${escapeHtml(PrairieRunView.itemCourseName(item))}</span>` : ""}</div>
      </div></div>
      <div class="prr-actions">${progressBadge}
        ${editHtml}
      </div>
    </li>`;
  }

  function sourceTitle(item) {
    return { prairielearn: "PrairieLearn", gradescope: "Gradescope", canvas: "Canvas", prairietest: "PrairieTest" }[item?.source] || String(item?.source || "");
  }

  function listMarkup() {
    const current = visibleAssignments().sort(PrairieRunView.compareAssignments);
    if (!current.length) return `<li class="list-group-item text-muted">${deadlineMode ? "No assignments due today or later. Sync sources to refresh." : "No assignments due today or later. Scan PrairieLearn to refresh."}</li>`;
    const groups = new Map();
    current.forEach((item) => {
      const key = PrairieRunView.itemCourseKey(item);
      if (!groups.has(key)) groups.set(key, { name: PrairieRunView.itemCourseName(item), items: [] });
      groups.get(key).items.push(item);
    });
    const classGroups = [...groups.values()].map((group) => {
      const uncompleted = group.items.filter((item) => !PrairieRunView.isCompleted(item));
      const completed = group.items.filter(PrairieRunView.isCompleted);
      const topThree = uncompleted.filter((item) => PrairieRunView.dueDateKey(item)).slice(0, 3);
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

  async function persist() {
    if (deadlineMode) await PrairieRunExt.storageLocalSet({ [DEADLINES_KEY]: assignments });
    else await PrairieRunExt.storageLocalSet({ [ASSIGNMENTS_KEY]: assignments });
    render();
  }

  // Central wall-clock { date, time } for <input type=date/time> from a UTC instant.
  function centralInputParts(isoUtc) {
    const date = new Date(isoUtc);
    if (Number.isNaN(date.getTime())) return null;
    const parts = {};
    const dtf = new Intl.DateTimeFormat("en-US", {
      timeZone: "America/Chicago",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
    });
    for (const part of dtf.formatToParts(date)) {
      if (part.type !== "literal") parts[part.type] = part.value;
    }
    return { date: `${parts.year}-${parts.month}-${parts.day}`, time: `${parts.hour === "24" ? "00" : parts.hour}:${parts.minute}` };
  }

  function toLegacyForSync(item) {
    try {
      if (globalThis.PrairieRunModel?.toLegacyPlAssignment) {
        return { ...globalThis.PrairieRunModel.toLegacyPlAssignment(item, {}), syncState: item.syncState === "new" ? "new" : "changed" };
      }
    } catch {
      // Fall through to the raw item.
    }
    return item;
  }

  async function editDueDate(id) {
    const item = assignments.find((entry) => entry.id === id); if (!item) return;
    if (!PrairieRunView.canEditDate(item)) return;
    const wallCurrent = item.manuallyEnteredDueAt || item.dueAtLocal || "";
    let normalizedCurrent = wallCurrent.replace(" ", "T").slice(0, 16);
    if (!normalizedCurrent && item.dueAt) {
      const parts = centralInputParts(item.dueAt);
      if (parts) normalizedCurrent = `${parts.date}T${parts.time}`;
    }
    const dialog = document.createElement("dialog");
    dialog.className = "prr-date-dialog";
    dialog.innerHTML = `<form method="dialog"><h3>Assignment due date</h3><label>Date <input type="date" name="date" value="${escapeHtml(normalizedCurrent.slice(0, 10))}" /></label><label>Time <input type="time" name="time" value="${escapeHtml(normalizedCurrent.slice(11, 16))}" /></label><div class="prr-dialog-actions"><button value="cancel" class="btn btn-secondary">Cancel</button><button value="remove" class="btn btn-outline-danger">Remove date</button><button value="save" class="btn btn-primary">Save</button></div></form>`;
    document.body.append(dialog);
    dialog.addEventListener("close", async () => {
      if (dialog.returnValue === "save") {
        const date = dialog.querySelector('[name="date"]').value;
        const time = dialog.querySelector('[name="time"]').value;
        if (!date || !time) { dialog.remove(); alert("Choose both a date and time."); return; }
        item.manuallyEnteredDueAt = `${date} ${time}`;
        item.dueAtLocal = item.manuallyEnteredDueAt;
        if (deadlineMode && item.dueAt !== undefined) {
          try {
            if (globalThis.PrairieRunModel?.localToUtc) {
              item.dueAt = globalThis.PrairieRunModel.localToUtc(`${date} ${time}:00`, item.sourceTimezone || "America/Chicago");
            } else {
              item.dueAt = null;
            }
          } catch {
            item.dueAt = null;
          }
        } else {
          item.syncState = item.syncState === "new" ? "new" : "changed";
        }
      } else if (dialog.returnValue === "remove") {
        item.manuallyEnteredDueAt = null;
        item.dueAtLocal = null;
        if (deadlineMode && item.dueAt !== undefined) item.dueAt = null;
      }
      dialog.remove();
      if (dialog.returnValue === "save" || dialog.returnValue === "remove") {
        await persist();
        const payload = deadlineMode ? toLegacyForSync(item) : item;
        PrairieRunExt.runtimeSendMessage({ type: "PRAIRIERUN_ASSIGNMENT_UPDATED", assignment: payload }).catch(() => undefined);
      }
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
    PrairieRunExt.storageLocalGet([ASSIGNMENTS_KEY, DEADLINES_KEY, SETTINGS_KEY]).then((stored) => {
      // Prefer the merged multi-source deadlines when present; otherwise fall
      // back to the legacy PrairieLearn assignments.
      deadlineMode = Array.isArray(stored[DEADLINES_KEY]);
      assignments = (deadlineMode ? stored[DEADLINES_KEY] : stored[ASSIGNMENTS_KEY]) || [];
      settings = { ...settings, ...(stored[SETTINGS_KEY] || {}) };
      if (placePanel()) return;
      const observer = new MutationObserver(() => { if (placePanel()) observer.disconnect(); });
      observer.observe(document.body, { childList: true, subtree: true });
      setTimeout(() => observer.disconnect(), 8000);
    });
  }

  function update(nextAssignments) {
    // In deadline mode the panel renders prairierunDeadlines (kept fresh via
    // the storage listener); legacy scan pushes must not clobber that view.
    if (deadlineMode) return;
    assignments = nextAssignments || assignments;
    if (panel) render();
  }

  PrairieRunExt.addStorageChangedListener((changes, areaName) => {
    if (areaName !== "local") return;
    if (changes[DEADLINES_KEY]) {
      const next = changes[DEADLINES_KEY].newValue;
      if (Array.isArray(next)) {
        deadlineMode = true;
        assignments = next;
      } else {
        deadlineMode = false;
        PrairieRunExt.storageLocalGet([ASSIGNMENTS_KEY]).then((stored) => {
          assignments = stored[ASSIGNMENTS_KEY] || assignments;
          render();
        }).catch(() => undefined);
        return;
      }
    } else if (changes[ASSIGNMENTS_KEY] && !deadlineMode) {
      assignments = changes[ASSIGNMENTS_KEY].newValue || assignments;
    }
    if (changes[SETTINGS_KEY]) settings = { ...settings, ...(changes[SETTINGS_KEY].newValue || {}) };
    if (changes[ASSIGNMENTS_KEY] || changes[DEADLINES_KEY] || changes[SETTINGS_KEY]) render();
  });

  window.PrairieRunHomePanel = { mount, update };
})();
