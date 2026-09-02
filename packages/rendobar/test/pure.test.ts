import { describe, it, expect } from "vitest";
import {
  fingerprint,
  isPubliclyReachable,
  callbackStillComing,
  jobIdFromEnvelope,
  webhookRegistrationHelp,
  requireJobId,
  raiseIfJobFailed,
} from "../src/lib/common/pure.js";
import { stringsFrom } from "../../../scripts/lib/i18n.mjs";

/**
 * The Activepieces piece's money and hang decisions.
 *
 * The piece itself only compiles inside the Activepieces monorepo, so nothing
 * that imports `@activepieces/*` can be tested from here. Its risky logic was
 * deliberately kept import free (`common/pure.ts`) so it can be exercised in
 * the same CI that guards every other contract these connectors rely on. A test
 * that only runs in someone else's repo is a test that never runs.
 *
 * This file sits beside connector-contract.test.ts for the same reason: both
 * pin promises a connector depends on and cannot verify for itself.
 */

describe("idempotency fingerprint", () => {
  const submission = { type: "ffmpeg", inputs: { a: "https://x/v.mp4" }, params: { crf: 23 } };

  it("rebuilds the same key for the same submission", () => {
    // The whole point. Activepieces retries a failed step on its own, and a
    // retry that produced a new key would submit and bill a second job.
    expect(fingerprint(submission)).toBe(fingerprint({ ...submission }));
  });

  it("ignores key order at every level", () => {
    // `{a,b}` and `{b,a}` are the same request. Treating them as different
    // would bill twice for one submission.
    expect(fingerprint({ a: 1, b: 2 })).toBe(fingerprint({ b: 2, a: 1 }));
    expect(fingerprint({ p: { a: 1, b: 2 } })).toBe(fingerprint({ p: { b: 2, a: 1 } }));
  });

  it("separates two different submissions", () => {
    // POST /jobs matches a repeated key on (org, key) ALONE and never compares
    // payloads, so a colliding key silently returns the FIRST job and discards
    // this step's parameters.
    expect(fingerprint({ ...submission, params: { crf: 28 } })).not.toBe(fingerprint(submission));
    expect(fingerprint({ ...submission, type: "ffprobe" })).not.toBe(fingerprint(submission));
  });

  it("keeps array order significant", () => {
    // Inputs are ordered. [a,b] and [b,a] are different jobs.
    expect(fingerprint({ i: [1, 2] })).not.toBe(fingerprint({ i: [2, 1] }));
  });

  it("drops undefined without conflating it with null", () => {
    expect(fingerprint({ a: 1 })).toBe(fingerprint({ a: 1, b: undefined }));
    expect(fingerprint({ a: 1, b: null })).not.toBe(fingerprint({ a: 1 }));
  });

  it("would change if the callback URL were folded in, which is why it is not", () => {
    // The regression this guards. A retry mints a fresh waitpoint and so a
    // fresh resume URL. If the submission carrying it were fingerprinted, every
    // retry would get a new key and bill a new job, undoing the rest of this
    // file. The key is taken from the submission BEFORE the callback is added.
    const a = { ...submission, callback: { url: "https://ap.io/resume/AAA" } };
    const b = { ...submission, callback: { url: "https://ap.io/resume/BBB" } };
    expect(fingerprint(a)).not.toBe(fingerprint(b));
    expect(fingerprint(submission)).not.toBe(fingerprint(a));
  });
});

describe("callback reachability", () => {
  /**
   * Mirrors validateWebhookUrl in apps/api/src/lib/webhooks.ts. Stricter than
   * the server is safe (the flow polls); looser is not (the callback is
   * attached, the submit is refused 400, and the job never runs at all).
   */
  it("accepts a host Rendobar can actually reach", () => {
    expect(isPubliclyReachable("https://cloud.activepieces.com/api/v1/resume/abc")).toBe(true);
    expect(isPubliclyReachable("https://automate.acme.com/api/v1/resume/x")).toBe(true);
  });

  it("refuses anything that is not HTTPS", () => {
    expect(isPubliclyReachable("http://automate.acme.com/r")).toBe(false);
    expect(isPubliclyReachable("not a url")).toBe(false);
  });

  it.each([
    ["localhost", "https://localhost:8080/r"],
    ["127.0.0.0/8", "https://127.0.0.1/r"],
    ["10.0.0.0/8", "https://10.1.2.3/r"],
    ["172.16.0.0/12", "https://172.20.0.5/r"],
    ["192.168.0.0/16", "https://192.168.1.50/r"],
    ["IPv6 loopback", "https://[::1]/r"],
    [".internal", "https://ap.corp.internal/r"],
    [".local", "https://ap.home.local/r"],
    ["cloud metadata", "https://169.254.169.254/r"],
    ["Alibaba metadata", "https://100.100.100.200/r"],
    ["IPv4-mapped IPv6", "https://[::ffff:7f00:1]/r"],
    ["workers.dev", "https://ap.workers.dev/r"],
    ["pages.dev", "https://ap.pages.dev/r"],
  ])("refuses %s", (_label, url) => {
    expect(isPubliclyReachable(url)).toBe(false);
  });

  it("does not over-reach past the private ranges", () => {
    // 172.32 is public; only 172.16-31 is private. Blocking it would push a
    // reachable instance onto the polling path for no reason.
    expect(isPubliclyReachable("https://172.32.0.5/r")).toBe(true);
  });

  it("is not looser than the server on any case the server rejects", () => {
    // The direction that matters. Every host the API refuses must also be
    // refused here, or the job never gets submitted at all.
    const serverRejects = [
      "http://x.com/r", "https://localhost/r", "https://127.0.0.1/r",
      "https://10.0.0.1/r", "https://172.16.0.1/r", "https://172.31.255.255/r",
      "https://192.168.0.1/r", "https://0.0.0.0/r", "https://[::1]/r",
      "https://[fc00::1]/r", "https://[fe80::1]/r", "https://a.internal/r",
      "https://a.local/r", "https://169.254.169.254/r", "https://100.100.1.1/r",
      "https://[::ffff:a00:1]/r", "https://a.workers.dev/r", "https://a.pages.dev/r",
    ];
    expect(serverRejects.filter(isPubliclyReachable)).toEqual([]);
  });
});

describe("whether a callback is still coming", () => {
  it("says yes for an ordinary accepted job", () => {
    expect(callbackStillComing({ id: "job_1", status: "waiting" })).toBe(true);
  });

  it("says no on an idempotent hit", () => {
    // The key matched a job submitted earlier, which carries the EARLIER call's
    // callback URL. Rendobar resumes that waitpoint, not this one, so pausing
    // here would hang for the waitpoint's full 30 days.
    expect(callbackStillComing({ id: "job_1", status: "waiting", idempotent: true })).toBe(false);
  });

  it.each(["complete", "failed", "cancelled"])("says no for a job already %s", (status) => {
    // A sync job type ran inline. Its callback is dispatched from the same
    // request that answered us, so it can land before the run is even marked
    // paused, and a resume that arrives first is lost.
    expect(callbackStillComing({ id: "job_1", status })).toBe(false);
  });

  it("says yes when the response omits a status", () => {
    // Absent is not terminal. Defaulting the other way would silently disable
    // pausing for every job the moment the field were renamed.
    expect(callbackStillComing({ id: "job_1" })).toBe(true);
  });
});

describe("reading the callback body", () => {
  it("takes the job id out of the envelope", () => {
    expect(
      jobIdFromEnvelope({ event: "job.completed", data: { jobId: "job_abc", status: "complete" } }),
    ).toBe("job_abc");
  });

  it("returns nothing rather than throwing on a body that is not one", () => {
    // Anything can POST to a resume URL. A malformed body must produce a clear
    // step error, never a crash inside the piece.
    for (const body of [null, undefined, "", 42, {}, { data: null }, { data: { jobId: "" } }, { data: { jobId: 7 } }]) {
      expect(() => jobIdFromEnvelope(body)).not.toThrow();
      expect(jobIdFromEnvelope(body)).toBeUndefined();
    }
  });
});

describe("translatable strings", () => {
  /**
   * The scanner behind the sync script's i18n drift check. It only ever reports
   * strings MISSING from translation.json, because Activepieces' own generator
   * sees strings this cannot (the ~30 createCustomApiCallAction contributes),
   * and regenerating from source would delete them. These tests pin that it
   * reads what the framework translates and skips what it does not.
   */
  it("finds displayName, description and option labels", () => {
    const found = stringsFrom(`
      export const x = createAction({
        displayName: 'Run a Media Job',
        description: 'Submit a job.',
        props: { p: Property.StaticDropdown({ options: { options: [{ label: 'Any', value: 'a' }] } }) },
      });
    `);
    expect(found).toEqual(["Run a Media Job", "Submit a job.", "Any"]);
  });

  it("skips aiMetadata, which is read by models and never shown", () => {
    const found = stringsFrom(`
      export const x = createAction({
        displayName: 'Real',
        aiMetadata: { description: 'Not shown to a person.', idempotent: true },
      });
    `);
    expect(found).toEqual(["Real"]);
  });

  it("skips outputSchema labels, which the framework does not translate", () => {
    const found = stringsFrom(`
      export const x = createAction({
        displayName: 'Real',
        outputSchema: { fields: [{ key: 'a', label: 'Not translated' }] },
      });
    `);
    expect(found).toEqual(["Real"]);
  });

  it("skips a template literal, which has no stable key to translate", () => {
    expect(stringsFrom("displayName: `Job ${id}`")).toEqual([]);
  });

  it("reads an escaped quote back as the string the user sees", () => {
    // The TS literal needs a doubled backslash so the SCANNED text contains a
    // real one. A single \' inside double quotes is just a quote, which is what
    // made the first version of this test pass a string with no escape in it.
    expect(stringsFrom("description: 'the job\\'s output'")).toEqual(["the job's output"]);
  });
});

describe("diagnosing a refused webhook registration", () => {
  /**
   * Two problems land in the same catch and need opposite fixes. Reporting both
   * as "not reachable from the internet" sent a scope problem off to check its
   * network, which became the likely case once Rendobar keys carried scopes.
   */
  it("names the scope when the key is narrowed, not the network", () => {
    const help = webhookRegistrationHelp("This endpoint requires the webhooks:write scope.");
    expect(help).toContain("webhooks:write");
    expect(help).not.toContain("not reachable from the internet");
  });

  it("recognises the RFC 6750 challenge wording too", () => {
    expect(webhookRegistrationHelp('Bearer error="insufficient_scope"')).toContain("webhooks:write scope");
  });

  it("still points an unreachable instance at the polling trigger", () => {
    const help = webhookRegistrationHelp("connect ETIMEDOUT 10.0.0.1:443");
    expect(help).toContain("not reachable from the internet");
    expect(help).toContain("Polling");
  });

  it("offers polling in both branches, because it is the way out of either", () => {
    for (const reason of ["This endpoint requires the webhooks:write scope.", "socket hang up"]) {
      expect(webhookRegistrationHelp(reason)).toContain("Polling");
    }
  });
});

describe("a step given no job", () => {
  /**
   * Found on a live Activepieces: an expression that resolved to nothing sent
   * an empty id, the piece called `/jobs/`, and Rendobar answered "Route not
   * found" — which names neither the step at fault nor the fix.
   */
  it("says which field is wrong instead of letting the URL break", () => {
    for (const empty of ["", "   ", undefined, null, 42]) {
      expect(() => requireJobId(empty)).toThrow(/No job was given/);
    }
  });

  it("passes a real id through, trimmed", () => {
    expect(requireJobId("job_abc")).toBe("job_abc");
    expect(requireJobId("  job_abc  ")).toBe("job_abc");
  });
});

describe("a job that failed", () => {
  /**
   * A failed job used to return a GREEN step carrying succeeded:false, so the
   * flow's error path never ran. Every other step fails when its work fails.
   */
  it("fails the step, naming the reason", () => {
    expect(() =>
      raiseIfJobFailed({ status: "failed", error_code: "BAD_INPUT", error_message: "Unreadable file" }, true),
    ).toThrow(/failed: Unreadable file \(BAD_INPUT\)/);
  });

  it("still fails usefully when the job reported no reason", () => {
    expect(() => raiseIfJobFailed({ status: "failed" }, true)).toThrow(/Get Job Logs/);
  });

  it("treats a cancelled job as a failure too", () => {
    expect(() => raiseIfJobFailed({ status: "cancelled" }, true)).toThrow(/cancelled/);
  });

  it("does nothing when the author turned it off", () => {
    expect(() => raiseIfJobFailed({ status: "failed", error_message: "x" }, false)).not.toThrow();
  });

  it("never fails a job that is merely unfinished", () => {
    // Waiting can hit its own deadline while the job carries on. Reporting that
    // as a broken job would be wrong.
    for (const status of ["waiting", "dispatched", "running", "complete"]) {
      expect(() => raiseIfJobFailed({ status }, true)).not.toThrow();
    }
  });
});
