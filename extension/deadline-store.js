// PrairieRun deadline store (PR 7): per-source merge, course linking, cross-source dedupe.
// No bundler: plain IIFE script. Loads in background, options, and Node tests.
(function () {
  // Dedupe window: two items with the same normalized title in linked courses
  // merge only when both have dueAt and |delta| <= 5 minutes.
  const DEDUPE_WINDOW_MS = 5 * 60 * 1000;

  // Winner precedence: sources with real status beat the Canvas feed.
  const PRECEDENCE = {
    prairielearn: 0,
    gradescope: 1,
    prairietest: 2,
    canvas: 3,
    manual: 4,
  };

  const LINKED_SOURCES = ["prairielearn", "gradescope", "canvas", "prairietest"];

  function precedenceOf(source) {
    const rank = PRECEDENCE[source];
    return typeof rank === "number" ? rank : 99;
  }

  function model() {
    return globalThis.PrairieRunModel || null;
  }

  function fingerprintOf(item) {
    try {
      if (model()?.fingerprint) return model().fingerprint(item);
    } catch {
      // Fall through to the JSON fallback.
    }
    return JSON.stringify(item);
  }

  // Normalize a course code for grouping: uppercase, single spaces.
  // Extracts the core "SUBJ NNN" prefix so long display names such as
  // "CS 425 AL1 Fall 2026 CRN12345" group under "CS 425".
  function normalizeCourseCode(value) {
    const upper = String(value || "").toUpperCase().replace(/_/g, " ").replace(/\s+/g, " ").trim();
    if (!upper) return "";
    const match = upper.match(/^([A-Z]{2,4})\s+(\d{3}[A-Z]{0,3})/);
    return match ? `${match[1]} ${match[2]}` : upper;
  }

  function courseCodeOf(item) {
    if (item?.courseCode) return normalizeCourseCode(item.courseCode);
    try {
      const derived = model()?.courseCodeFromName?.(item?.courseName || "");
      if (derived) return normalizeCourseCode(derived);
    } catch {
      // Ignore; fall through to empty.
    }
    return "";
  }

  // Normalize a title for cross-source comparison: lowercase, collapse
  // whitespace, strip punctuation, drop a trailing "(... CRN<digits> ...)"
  // section suffix such as the Canvas "CS 425 AL1 Fall 2026 CRN12345" tag.
  function normTitle(value) {
    let text = String(value || "").toLowerCase();
    text = text.replace(/\(.*?crn\s*\d+.*?\)\s*$/u, "");
    text = text.replace(/[^\p{L}\p{N} ]+/gu, "");
    return text.replace(/\s+/g, " ").trim();
  }

  // Group items by normalized course code. Returns CourseLinks with
  // confirmed:false (suggestions only; the user confirms in the options page).
  function suggestCourseLinks(items) {
    const links = {};
    for (const item of items || []) {
      const code = courseCodeOf(item);
      if (!code) continue;
      const source = item?.source;
      const courseKey = item?.courseKey;
      if (!source || !courseKey) continue;
      if (!LINKED_SOURCES.includes(source)) continue;
      if (!links[code]) links[code] = { confirmed: false };
      const entry = links[code];
      if (!Array.isArray(entry[source])) entry[source] = [];
      if (!entry[source].includes(courseKey)) {
        entry[source].push(courseKey);
        entry[source].sort();
      }
    }
    return links;
  }

  // Index confirmed links: courseKey -> course code. Only confirmed:true
  // links participate in merging; suggestions never merge by themselves.
  function confirmedLinkIndex(links) {
    const index = new Map();
    for (const [code, entry] of Object.entries(links || {})) {
      if (!entry || entry.confirmed !== true) continue;
      for (const [source, keys] of Object.entries(entry)) {
        if (source === "confirmed" || !Array.isArray(keys)) continue;
        for (const key of keys) {
          if (key != null && !index.has(key)) index.set(key, code);
        }
      }
    }
    return index;
  }

  function cloneItem(item) {
    return {
      ...item,
      aliases: [...(item?.aliases || [])],
      sourceUrls: [...(item?.sourceUrls || [])],
    };
  }

  function unionLists(first, second) {
    return [...new Set([...(first || []), ...(second || [])])];
  }

  function mergePair(winner, loser) {
    const merged = cloneItem(winner);
    merged.aliases = unionLists(unionLists(merged.aliases, [loser.id]), loser.aliases || []);
    const loserUrls = [...(loser.url ? [loser.url] : []), ...(loser.sourceUrls || [])];
    merged.sourceUrls = unionLists(merged.sourceUrls, loserUrls);
    if ((merged.status || "unknown") === "unknown" && loser.status && loser.status !== "unknown") {
      merged.status = loser.status;
    }
    return merged;
  }

  function dueMs(item) {
    if (!item?.dueAt) return null;
    const ms = Date.parse(item.dueAt);
    return Number.isNaN(ms) ? null : ms;
  }

  // Dedupe items across confirmed course links. Returns { items, nearMisses }.
  // nearMisses holds [{ a, b, deltaMinutes }] for same-title pairs in linked
  // courses whose due dates differ by more than 5 minutes (never merged).
  function dedupe(items, links) {
    const working = (items || []).map(cloneItem);
    const linkIndex = confirmedLinkIndex(links);
    const nearMisses = [];

    // Group candidate indexes by (linked course code, normalized title).
    const groups = new Map();
    working.forEach((item, index) => {
      const code = item?.courseKey != null ? linkIndex.get(item.courseKey) : undefined;
      if (!code) return;
      const key = `${code}\n${normTitle(item?.title)}`;
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(index);
    });

    const removed = new Set();
    for (const indexes of groups.values()) {
      if (indexes.length < 2) continue;
      // Deterministic winner: highest precedence first, then stable id order.
      const ordered = [...indexes].sort((a, b) => {
        const rank = precedenceOf(working[a]?.source) - precedenceOf(working[b]?.source);
        if (rank !== 0) return rank;
        return String(working[a]?.id || "").localeCompare(String(working[b]?.id || ""));
      });
      let winnerIndex = ordered[0];
      for (let i = 1; i < ordered.length; i += 1) {
        const candidateIndex = ordered[i];
        const winner = working[winnerIndex];
        const candidate = working[candidateIndex];
        // Never merge two items from the same source: without a second
        // source there is no cross-source evidence, so leave both in place.
        if (candidate.source === winner.source) continue;
        const winnerDue = dueMs(winner);
        const candidateDue = dueMs(candidate);
        if (winnerDue == null || candidateDue == null) continue;
        const deltaMinutes = Math.abs(winnerDue - candidateDue) / 60000;
        if (Math.abs(winnerDue - candidateDue) <= DEDUPE_WINDOW_MS) {
          working[winnerIndex] = mergePair(winner, candidate);
          removed.add(candidateIndex);
        } else {
          nearMisses.push({
            a: winner.id,
            b: candidate.id,
            deltaMinutes: Math.round(deltaMinutes * 10) / 10,
          });
        }
      }
    }

    const deduped = working.filter((_, index) => !removed.has(index));
    nearMisses.sort((a, b) => String(a.a).localeCompare(String(b.a)) || String(a.b).localeCompare(String(b.b)));
    return { items: deduped, nearMisses };
  }

  function sortedUnique(values) {
    return [...new Set((values || []).map(String))].sort();
  }

  function sameList(first, second) {
    const a = sortedUnique(first);
    const b = sortedUnique(second);
    return a.length === b.length && a.every((value, index) => value === b[index]);
  }

  function itemChanged(before, after) {
    if (!before) return true;
    if (fingerprintOf(before) !== fingerprintOf(after)) return true;
    if (!sameList(before.aliases, after.aliases)) return true;
    if (!sameList(before.sourceUrls, after.sourceUrls)) return true;
    return false;
  }

  // Alias-aware diff: an id that moved into a winner's aliases (merge) or
  // arrived via an alias is a change/continuation, never an add+remove pair.
  function diffChanges(prevById, nextItems) {
    const nextById = new Map(nextItems.map((item) => [item.id, item]));
    const prevAliasToId = new Map();
    for (const [id, item] of prevById) {
      for (const alias of item?.aliases || []) {
        if (!prevAliasToId.has(String(alias))) prevAliasToId.set(String(alias), id);
      }
    }
    const nextAliasToId = new Map();
    for (const item of nextItems) {
      for (const alias of item?.aliases || []) {
        if (!nextAliasToId.has(String(alias))) nextAliasToId.set(String(alias), item.id);
      }
    }

    const added = [];
    const changed = [];
    for (const item of nextItems) {
      const before = prevById.get(item.id);
      if (before) {
        if (itemChanged(before, item)) changed.push(item.id);
        continue;
      }
      let anchor = null;
      for (const alias of item.aliases || []) {
        if (prevById.has(alias)) {
          anchor = prevById.get(alias);
          break;
        }
      }
      if (!anchor && prevAliasToId.has(item.id)) anchor = prevById.get(prevAliasToId.get(item.id));
      if (anchor) {
        if (itemChanged(anchor, item)) changed.push(item.id);
      } else {
        added.push(item.id);
      }
    }

    const removed = [];
    for (const [id, before] of prevById) {
      if (nextById.has(id)) continue;
      if (nextAliasToId.has(id)) continue;
      let carried = false;
      for (const alias of before?.aliases || []) {
        if (nextById.has(alias)) {
          carried = true;
          break;
        }
      }
      if (!carried) removed.push(id);
    }
    return { added, changed, removed };
  }

  // Per-source replacement merge with the PR 1 contract:
  // mergeSourceResults(prev, results, links, settings?) -> { items, changes, nearMisses }.
  // - status 'ok' replaces that source's items; signed_out/error/disabled or a
  //   source missing from results keeps the previous items unchanged, so a
  //   broken or signed-out source never wipes its items.
  // - settings.sources[id].enabled === false drops that source's items.
  function mergeSourceResults(prev = [], results = {}, links = {}, settings) {
    const prevItems = Array.isArray(prev) ? prev : [];
    const prevById = new Map();
    for (const item of prevItems) {
      if (item?.id != null && !prevById.has(item.id)) prevById.set(item.id, item);
    }
    const nextById = new Map(prevById);

    for (const [sourceId, result] of Object.entries(results || {})) {
      if (result?.status === "ok") {
        for (const [id, item] of [...nextById]) {
          if (item?.source === sourceId) nextById.delete(id);
        }
        for (const item of result.items || []) {
          if (item?.id != null) nextById.set(item.id, item);
        }
      }
      // Any non-ok status keeps the previous items for that source.
    }

    const sourceSettings = settings?.sources;
    if (sourceSettings && typeof sourceSettings === "object") {
      for (const [sourceId, entry] of Object.entries(sourceSettings)) {
        if (entry && entry.enabled === false) {
          for (const [id, item] of [...nextById]) {
            if (item?.source === sourceId) nextById.delete(id);
          }
        }
      }
    }

    const { items, nearMisses } = dedupe([...nextById.values()], links);
    return { items, changes: diffChanges(prevById, items), nearMisses };
  }

  const api = { mergeSourceResults, suggestCourseLinks, dedupe, normTitle, normalizeCourseCode };
  globalThis.PrairieRunDeadlineStore = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})();
