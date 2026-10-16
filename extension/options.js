// PrairieRun options bootstrap (PR 1 stub; later PRs own each section).
(function () {
  function renderComingSoon() {
    if (typeof document === "undefined") return;
    for (const id of ["sources", "canvas-settings", "course-links", "export", "output", "relay"]) {
      const section = document.getElementById(id);
      if (section && !section.querySelector("p")) {
        const note = document.createElement("p");
        note.className = "muted";
        note.textContent = "Coming soon";
        section.appendChild(note);
      }
    }
  }

  if (typeof document !== "undefined") {
    document.addEventListener("DOMContentLoaded", renderComingSoon);
  }

  const api = { renderComingSoon };
  globalThis.PrairieRunOptions = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})();
