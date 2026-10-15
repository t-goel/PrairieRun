// Read-only verification of legacy assessment -> existing student attempt.
// PrairieLearn's studentAssessmentRedirect middleware runs on all subpaths.
// An unused suffix reaches that redirect, but never the GET '/' handler which
// can create an unstarted homework attempt. A 404 or login redirect is ignored.
(function () {
  async function resolveParentCandidates(candidates, pageUrl, fetcher = fetch) {
    const origin = new URL(pageUrl).origin;
    const verified = new Map();
    const links = {};
    for (const candidate of candidates) {
      const { courseInstanceId, assessmentId, instanceId } = candidate;
      if (![courseInstanceId, assessmentId, instanceId].every((id) => /^\d+$/.test(String(id)))) continue;
      const canonical = `pl:${courseInstanceId}:assessment:${assessmentId}`;
      if (!verified.has(canonical)) {
        const probe = `${origin}/pl/course_instance/${courseInstanceId}/assessment/${assessmentId}/__prairierun_identity__`;
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 10000);
        try {
          const response = await fetcher(probe, { method: 'GET', credentials: 'same-origin', redirect: 'follow', signal: controller.signal });
          const final = new URL(response.url);
          const match = final.pathname.match(/^\/pl\/course_instance\/(\d+)\/assessment_instance\/(\d+)\/?$/);
          verified.set(canonical, response.ok && final.origin === origin && match && match[1] === String(courseInstanceId) ? match[2] : null);
        } catch { verified.set(canonical, null); }
        finally { clearTimeout(timeout); }
      }
      if (verified.get(canonical) === String(instanceId)) {
        const key = `pl:${courseInstanceId}:instance:${instanceId}`;
        // Refuse ambiguous redirects rather than allowing the last candidate to win.
        if (links[key] && links[key] !== canonical) links[key] = null;
        else if (links[key] !== null) links[key] = canonical;
      }
    }
    return Object.fromEntries(Object.entries(links).filter(([, value]) => value));
  }
  const api = { resolveParentCandidates };
  globalThis.PrairieRunIdentity = api;
  if (typeof module !== 'undefined') module.exports = api;
})();
