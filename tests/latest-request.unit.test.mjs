import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { LatestRequestGate } from "../app/lib/latest-request.ts";

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

test("latest request gate aborts the prior fetch and stale resolution cannot overwrite the current selection", async () => {
  const gate = new LatestRequestGate();
  const oldRequest = deferred();
  const currentRequest = deferred();
  const applied = [];
  const errors = [];
  let oldSignal;
  const oldRun = gate.run((signal) => { oldSignal = signal; return oldRequest.promise; }, (value) => applied.push(value), (error) => errors.push(error));
  const currentRun = gate.run((signal) => { assert.equal(signal.aborted, false); return currentRequest.promise; }, (value) => applied.push(value), (error) => errors.push(error));
  assert.equal(oldSignal.aborted, true);
  currentRequest.resolve("current");
  await currentRun;
  oldRequest.resolve("stale");
  await oldRun;
  assert.deepEqual(applied, ["current"]);
  assert.deepEqual(errors, []);
});

test("stale rejection is silent and MaterialsHub plus GradingDesk use guarded signal-aware fetches", async () => {
  const gate = new LatestRequestGate();
  const stale = deferred();
  const current = deferred();
  const errors = [];
  const first = gate.run(() => stale.promise, () => assert.fail("stale success applied"), (error) => errors.push(error));
  const second = gate.run(() => current.promise, () => {}, (error) => errors.push(error));
  stale.reject(new Error("old route failed"));
  current.resolve("ok");
  await Promise.all([first, second]);
  assert.deepEqual(errors, []);

  const page = await readFile(new URL("../app/page.tsx", import.meta.url), "utf8");
  for (const marker of ["refreshGate", "deepLinkGate", "assignmentListGate", "submissionListGate", "submissionGate", "learningApi.availableFiles(signal)", "learningApi.assignmentSubmissions(id, signal)", "learningApi.getSubmission(id, signal)"]) assert.ok(page.includes(marker), marker);
});
