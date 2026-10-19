// PrairieRun deadline store (PR 7): per-source merge, course linking, cross-source dedupe.
// No bundler: plain IIFE script. Loads in background, options, and Node tests.
(function () {
  // Dedupe window: two items with equal or prefix-related normalized titles
  // in linked course families merge only when both have dueAt and |delta|
  // <= 5 minutes.
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

  // Course family heuristic: trailing section/instance suffixes that may be
  // ignored when deciding whether two course codes are the same course
  // ("CS498" / "CS498DK" / "CS498DK2" are one family). Treated as heuristic;
  // extend this list for new naming schemes. Longest entries are matched
  // first when stripping, so e.g. "DK2" wins over "DK".
  const COURSE_FAMILY_SUFFIXES = ["DK2", "DK", "D2", "ONL", "ON", "X", "A", "B", "C", "AD1", "AL1"];

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

  // Normalize a course code for grouping: uppercase, strip ALL whitespace and
  // non-alphanumeric punctuation, so "CS 498", "cs-498", and "CS498" produce
  // the same key. Keeps a leading "SUBJ + 3 digits (+ up to 3 trailing
  // letters/digits)" core so long display names such as "CS 425 AL1 Fall
  // 2026 CRN12345" do not leak into the key; the family rule below re-links
  // suffixed variants into one family.
  function normalizeCourseCode(value) {
    const text = String(value || "").toUpperCase().replace(/[^A-Z0-9]/g, "");
    if (!text) return "";
    const match = text.match(/^([A-Z]{2,4})(\d{3})([A-Z0-9]{0,3})/);
    return match ? `${match[1]}${match[2]}${match[3] || ""}` : text;
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

  // Family rule: two normalized course codes belong to the same course family
  // when one is a left-prefix of the other and the extra tail (beyond the
  // shorter key) is either a known section/instance suffix ("CS498" vs
  // "CS498DK2") or a 2+ character tail with at least one letter. Digit-only
  // tails, and tails that continue the shorter key's trailing digit run, are
  // never families: "CS4" vs "CS498" and "CS49" vs "CS498" stay separate.
  function sameCourseFamily(first, second) {
    if (!first || !second) return false;
    if (first === second) return true;
    const [shorter, longer] = first.length <= second.length ? [first, second] : [second, first];
    if (!longer.startsWith(shorter)) return false;
    const extra = longer.slice(shorter.length);
    if (COURSE_FAMILY_SUFFIXES.includes(extra)) return true;
    if (/\d$/.test(shorter) && /^\d/.test(extra)) return false;
    return extra.length >= 2 && /[A-Z]/.test(extra);
  }

  // Transitive family clustering over normalized keys. Returns a Map of key
  // -> representative, where the representative is the family's shortest key
  // (lexicographic tiebreak), so "CS498", "CS498DK", and "CS498DK2" all map
  // to one suggested bucket whose code is "CS498".
  function familyMapOf(keys) {
    const unique = [...new Set(keys.filter(Boolean))];
    const parent = new Map(unique.map((key) => [key, key]));
    const find = (key) => {
      let root = key;
      while (parent.get(root) !== root) root = parent.get(root);
      while (parent.get(key) !== root) {
        const next = parent.get(key);
        parent.set(key, root);
        key = next;
      }
      return root;
    };
    for (let i = 0; i < unique.length; i += 1) {
      for (let j = i + 1; j < unique.length; j += 1) {
        if (!sameCourseFamily(unique[i], unique[j])) continue;
        const a = find(unique[i]);
        const b = find(unique[j]);
        if (a === b) continue;
        // Deterministic root; the final representative is recomputed from
        // full cluster membership below.
        const rep = a.length < b.length || (a.length === b.length && a.localeCompare(b) < 0) ? a : b;
        parent.set(a, rep);
        parent.set(b, rep);
      }
    }
    const clusters = new Map();
    for (const key of unique) {
      const root = find(key);
      if (!clusters.has(root)) clusters.set(root, []);
      clusters.get(root).push(key);
    }
    const map = new Map();
    for (const members of clusters.values()) {
      let rep = members[0];
      for (const key of members) {
        if (key.length < rep.length || (key.length === rep.length && key.localeCompare(rep) < 0)) rep = key;
      }
      for (const member of members) map.set(member, rep);
    }
    return map;
  }

  // Title family rule for near-miss detection: two normalized titles relate
  // when they are equal, or when one is a left-prefix of the other with a 2+
  // character extra tail ("quiz 1" vs "quiz 1 extension"). An all-digit tail
  // never relates ("quiz 1" vs "quiz 10" are different assignments).
  function relatedTitles(first, second) {
    if (!first || !second) return false;
    if (first === second) return true;
    const [shorter, longer] = first.length <= second.length ? [first, second] : [second, first];
    if (!longer.startsWith(shorter)) return false;
    const extra = longer.slice(shorter.length);
    return extra.length >= 2 && !/^\d+$/.test(extra);
  }

  // Group items by course code, then fold codes that belong to the same
  // course family into one suggested bucket keyed by the family's shortest
  // normalized code, so "CS 498 | CS 498DK | CS 498DK2" all appear under one
  // row ("CS498"). Returns CourseLinks with confirmed:false (suggestions
  // only; the user confirms in the options page).
  function suggestCourseLinks(items) {
    const byCode = {};
    for (const item of items || []) {
      const code = courseCodeOf(item);
      if (!code) continue;
      const source = item?.source;
      const courseKey = item?.courseKey;
      if (!source || !courseKey) continue;
      if (!LINKED_SOURCES.includes(source)) continue;
      if (!byCode[code]) byCode[code] = { confirmed: false };
      const entry = byCode[code];
      if (!Array.isArray(entry[source])) entry[source] = [];
      if (!entry[source].includes(courseKey)) {
        entry[source].push(courseKey);
        entry[source].sort();
      }
    }
    const family = familyMapOf(Object.keys(byCode));
    const links = {};
    for (const [code, entry] of Object.entries(byCode)) {
      const bucketCode = family.get(code) || code;
      if (!links[bucketCode]) links[bucketCode] = { confirmed: false };
      const target = links[bucketCode];
      for (const source of LINKED_SOURCES) {
        const keys = entry[source];
        if (!Array.isArray(keys)) continue;
        if (!Array.isArray(target[source])) target[source] = [];
        for (const key of keys) {
          if (!target[source].includes(key)) target[source].push(key);
        }
        target[source].sort();
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
  // Candidates are grouped by linked course *family*; a pair merges when its
  // normalized titles are equal or one is a title prefix of the other
  // (relatedTitles) and both due dates sit within 5 minutes. nearMisses holds
  // [{ a, b, deltaMinutes }] for related-title pairs in linked courses whose
  // due dates differ by more than 5 minutes (never merged).
  function dedupe(items, links) {
    const working = (items || []).map(cloneItem);
    const linkIndex = confirmedLinkIndex(links);
    const nearMisses = [];

    const codes = working.map((item) => {
      const raw = item?.courseKey != null ? linkIndex.get(item.courseKey) : null;
      return raw == null ? "" : normalizeCourseCode(raw);
    });
    const family = familyMapOf(codes);

    // Group candidate indexes by linked course family.
    const buckets = new Map();
    working.forEach((item, index) => {
      const code = codes[index];
      if (!code) return;
      const bucket = family.get(code) || code;
      if (!buckets.has(bucket)) buckets.set(bucket, []);
      buckets.get(bucket).push(index);
    });

    const removed = new Set();
    for (const indexes of buckets.values()) {
      if (indexes.length < 2) continue;
      // Deterministic order: highest precedence first, then stable id order.
      const ordered = [...indexes].sort((a, b) => {
        const rank = precedenceOf(working[a]?.source) - precedenceOf(working[b]?.source);
        if (rank !== 0) return rank;
        return String(working[a]?.id || "").localeCompare(String(working[b]?.id || ""));
      });
      // Pairwise over the ordered bucket: each item is a potential winner
      // against every later item whose related title makes it a duplicate or
      // a near miss. Same-source pairs are skipped: without a second source
      // there is no cross-source evidence, so leave both in place.
      for (let winnerAt = 0; winnerAt < ordered.length - 1; winnerAt += 1) {
        const winnerIndex = ordered[winnerAt];
        if (removed.has(winnerIndex)) continue;
        for (let candidateAt = winnerAt + 1; candidateAt < ordered.length; candidateAt += 1) {
          const candidateIndex = ordered[candidateAt];
          if (removed.has(candidateIndex)) continue;
          const winner = working[winnerIndex];
          const candidate = working[candidateIndex];
          if (candidate.source === winner.source) continue;
          if (!relatedTitles(normTitle(winner?.title), normTitle(candidate?.title))) continue;
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
