// PrairieRun course-link options (PR 1 stub; PR 7 owns internals).
(function () {
  function render(section) {
    if (!section || typeof document === "undefined") return;
    const note = document.createElement("p");
    note.className = "muted";
    note.textContent = "Coming soon";
    section.appendChild(note);
  }
  const api = { render };
  globalThis.PrairieRunOptionsCourses = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})();
