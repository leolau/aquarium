import { describe, expect, it } from "vitest";

import {
  CHECK_IN_CHOICES,
  DEFAULT_CHECK_IN,
  deviceFromHeaders,
  resolveViewMode,
  taskBucket,
  taskLists,
} from "./viewMode";
import { item } from "./taskFixtures";

const IPHONE = "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) Mobile/15E148 Safari/604.1";
const ANDROID = "Mozilla/5.0 (Linux; Android 14; Pixel 8) Chrome/120.0 Mobile Safari/537.36";
const MAC = "Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0) Chrome/120.0 Safari/537.36";

describe("device class", () => {
  it("reads phones from the client hint first, then the user agent", () => {
    expect(deviceFromHeaders(MAC, "?1")).toBe("phone");
    expect(deviceFromHeaders(IPHONE, "?0")).toBe("desktop");
    expect(deviceFromHeaders(IPHONE)).toBe("phone");
    expect(deviceFromHeaders(ANDROID)).toBe("phone");
    expect(deviceFromHeaders(MAC)).toBe("desktop");
    expect(deviceFromHeaders(null)).toBe("desktop");
  });
});

describe("resolveViewMode", () => {
  it("defaults to Task mode on phones and Project mode on desktop", () => {
    expect(resolveViewMode({}, "phone")).toBe("task");
    expect(resolveViewMode(null, "desktop")).toBe("project");
  });

  it("keeps each device class's own saved choice", () => {
    const saved = { phone: "project", desktop: "task" } as const;
    expect(resolveViewMode(saved, "phone")).toBe("project");
    expect(resolveViewMode(saved, "desktop")).toBe("task");
    expect(resolveViewMode({ desktop: "task" }, "phone")).toBe("task");
  });
});

describe("check-in picker", () => {
  it("maps each choice onto one autonomy, supervised by default", () => {
    const map = Object.fromEntries(CHECK_IN_CHOICES.map((c) => [c.label, c.autonomy]));
    expect(map).toEqual({
      "Before risky steps": "supervised",
      "Only at the end": "autonomous",
      "Every step": "manual",
    });
    expect(DEFAULT_CHECK_IN).toBe("supervised");
  });
});

describe("taskLists", () => {
  it("keeps only one-off, unarchived projects and counts the rest", () => {
    const lists = taskLists([
      item({ slug: "a" }),
      item({ slug: "b", cadence: "repeatable" }),
      item({ slug: "c", cadence: "standing" }),
      item({ slug: "d", archived: true }),
    ]);
    const slugs = [...lists.needsYou, ...lists.running, ...lists.done].map((i) => i.slug);
    expect(slugs).toEqual(["a"]);
    expect(lists.hiddenCount).toBe(2);
  });

  it("sorts each task into the list its own state says", () => {
    expect(taskBucket(item())).toBe("not_started");
    expect(taskBucket(item({ status: "planning" }))).toBe("running");
    expect(taskBucket(item({ latest_run: { run_no: 1, status: "running" } }))).toBe("running");
    expect(taskBucket(item({ latest_run: { run_no: 1, status: "waiting" } }))).toBe("needs_you");
    expect(taskBucket(item({ health: "attention" }))).toBe("needs_you");
    expect(
      taskBucket(item({ output_rollup: { total: 1, required: 1, delivered: 1, accepted: 0, awaiting_acceptance: 1 } })),
    ).toBe("needs_you");
    expect(taskBucket(item({ latest_run: { run_no: 2, status: "failed" } }))).toBe("failed");
    expect(taskBucket(item({ status: "done" }))).toBe("done");
  });

  it("puts an active task nobody started under Needs you, not Running", () => {
    const lists = taskLists([item()]);
    expect(lists.needsYou).toHaveLength(1);
    expect(lists.running).toHaveLength(0);
  });

  it("puts failed tasks under Needs you", () => {
    const lists = taskLists([item({ latest_run: { run_no: 1, status: "failed" } })]);
    expect(lists.needsYou).toHaveLength(1);
  });
});

describe("plan check", () => {
  it("lists a task waiting for its plan to be checked under Needs you", () => {
    expect(taskBucket(item({ plan_pending: true }))).toBe("needs_you");
  });
});
