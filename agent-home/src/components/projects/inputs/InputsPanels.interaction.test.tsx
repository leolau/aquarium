// @vitest-environment jsdom
/**
 * Every Inputs-tab write goes through useProjectAction: a double click is
 * one request, the button is pending while in flight, success shows the new
 * state, and a failure shows the reason with Retry (same key).
 */
import { cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const router = vi.hoisted(() => ({ push: vi.fn(), refresh: vi.fn() }));
vi.mock("next/navigation", () => ({
  usePathname: () => "/projects/mou", useRouter: () => router }));

import { AddToProjectSheet } from "@/components/projects/AddToProjectSheet";
import { LINK, PROJECT } from "@/components/projects/inputs/fixtures.test-helpers";
import type { UploadFn } from "@/components/projects/inputs/uploadProjectFile";
import { FilesPanel } from "@/components/projects/panels/FilesPanel";
import { MemoriesPanel } from "@/components/projects/panels/MemoriesPanel";
import { ReferencesPanel } from "@/components/projects/panels/ReferencesPanel";
import type { MemoryRow } from "@/types";

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status });
}

/** A fetch whose answers the test releases by hand. */
function heldFetch() {
  const held: { url: string; init?: RequestInit; release: (r: Response) => void }[] = [];
  const fetchMock = vi.fn(
    (input: RequestInfo | URL, init?: RequestInit) =>
      new Promise<Response>((resolve) => held.push({ url: String(input), init, release: resolve })),
  );
  return { fetchMock, held };
}

beforeEach(() => {
  router.push.mockClear();
  router.refresh.mockClear();
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("InputRow remove", () => {
  const project = {
    ...PROJECT,
    links: { memory: [LINK({ kind: "memory", ref: "mem_1", label: "Company details" })] },
  };

  it("double click → one DELETE, pending, then the row is gone", async () => {
    const { fetchMock, held } = heldFetch();
    vi.stubGlobal("fetch", fetchMock);
    const utils = render(<MemoriesPanel project={project} callerUserId="leo" />);
    const remove = utils.getByLabelText("Remove Company details");
    fireEvent.click(remove);
    fireEvent.click(remove);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(held[0].url).toBe("/api/projects/mou/links");
    expect(held[0].init?.method).toBe("DELETE");
    expect(JSON.parse(String(held[0].init?.body))).toEqual({ kind: "memory", ref: "mem_1", profile: "default" });
    expect(utils.getByText("Removing…")).toBeTruthy();
    expect((remove as HTMLButtonElement).disabled).toBe(true);
    held[0].release(json(200, { ok: true }));
    await waitFor(() => expect(utils.queryByText("Company details")).toBeNull());
    expect(utils.getByText("No memories linked yet", { exact: false })).toBeTruthy();
  });

  it("failure shows the reason and re-enables; Retry re-sends the same key", async () => {
    const { fetchMock, held } = heldFetch();
    vi.stubGlobal("fetch", fetchMock);
    const utils = render(<MemoriesPanel project={project} />);
    fireEvent.click(utils.getByLabelText("Remove Company details"));
    held[0].release(json(500, { detail: "boom" }));
    await utils.findByRole("alert");
    expect((utils.getByLabelText("Remove Company details") as HTMLButtonElement).disabled).toBe(false);
    fireEvent.click(utils.getByText("Retry"));
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const key = (i: number) => (held[i].init?.headers as Record<string, string>)["Idempotency-Key"];
    expect(key(1)).toBe(key(0));
    held[1].release(json(200, {}));
    await waitFor(() => expect(utils.queryByText("Company details")).toBeNull());
  });
});

describe("MemoriesPanel add", () => {
  const ROW: MemoryRow = {
    id: "mem_9",
    owner_user_id: "leo",
    visibility: "private",
    kind: "fact",
    topic: null,
    text: "ConnectAR Ltd company details",
    truncated: false,
    created_at: null,
    uses: 0,
    last_used: null,
    elevated: false,
    provenance: "user",
    score: 0.9,
  };

  it("Add memory opens the search seeded with the goal; Add links once and shows it", async () => {
    const linkCalls: RequestInit[] = [];
    let releaseLink!: () => void;
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.startsWith("/api/memory/rows")) return json(200, { rows: [ROW] });
      linkCalls.push(init!);
      await new Promise<void>((r) => (releaseLink = r));
      return json(200, { kind: "memory", ref: "mem_9", profile: "default", label: "ConnectAR Ltd company details", added_by: "leo" });
    });
    const memorySearch = vi.fn(async (input: RequestInfo | URL) => fetchMock(input));
    vi.stubGlobal("fetch", fetchMock);
    const utils = render(
      <MemoriesPanel project={PROJECT} callerUserId="leo" fetchImpl={memorySearch as unknown as typeof fetch} />,
    );
    fireEvent.click(utils.getByText("Add memory"));
    await utils.findByText("ConnectAR Ltd company details");
    expect(String(memorySearch.mock.calls[0][0])).toContain(encodeURIComponent("Draft the ConnectAR MOUs"));

    const add = utils.getByText("Add").closest("button")!;
    fireEvent.click(add);
    fireEvent.click(add);
    await waitFor(() => expect(linkCalls).toHaveLength(1));
    expect(JSON.parse(String(linkCalls[0].body))).toEqual({
      kind: "memory",
      ref: "mem_9",
      label: "ConnectAR Ltd company details",
    });
    expect(utils.getByText("Adding…")).toBeTruthy();
    releaseLink();
    await utils.findByText("✓ Added");
    expect(utils.getByLabelText("Remove ConnectAR Ltd company details")).toBeTruthy();
    expect(utils.queryByText("No memories linked yet", { exact: false })).toBeNull();
  });
});

describe("ReferencesPanel add link or note", () => {
  it("adds a note once, clears the box and lists it", async () => {
    const { fetchMock, held } = heldFetch();
    vi.stubGlobal("fetch", fetchMock);
    const utils = render(<ReferencesPanel project={PROJECT} callerUserId="leo" />);
    const box = utils.getByLabelText("Link or note");
    fireEvent.change(box, { target: { value: "Use HK governing law" } });
    const add = utils.getByText("Add").closest("button")!;
    fireEvent.click(add);
    fireEvent.click(add);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(JSON.parse(String(held[0].init?.body))).toEqual({
      kind: "reference",
      ref: "note:Use HK governing law",
      label: "Use HK governing law",
    });
    held[0].release(json(200, { kind: "reference", ref: "note:Use HK governing law", profile: "default" }));
    await utils.findByLabelText("Remove Use HK governing law");
    expect((box as HTMLInputElement).value).toBe("");
    expect(utils.getByText(/Note · added by you/)).toBeTruthy();
  });

  it("a refused add keeps the text and offers Retry", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => json(500, { detail: "nope" })));
    const utils = render(<ReferencesPanel project={PROJECT} />);
    const box = utils.getByLabelText("Link or note");
    fireEvent.change(box, { target: { value: "example.com" } });
    fireEvent.click(utils.getByText("Add"));
    await utils.findByText("Retry");
    expect((box as HTMLInputElement).value).toBe("example.com");
  });
});

describe("FilesPanel upload", () => {
  it("uploads a dropped file once with the chosen role, even if dropped twice, and lists it", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => json(200, {})));
    let release!: () => void;
    const upload = vi.fn<UploadFn>(async (req) => {
      await new Promise<void>((r) => (release = r));
      return {
        ok: true,
        status: 200,
        data: { kind: req.kind, ref: `leo/mou/${req.file.name}`, profile: "default", label: req.file.name },
        error: null,
      };
    });
    const utils = render(<FilesPanel project={PROJECT} callerUserId="leo" upload={upload} />);
    fireEvent.change(utils.getByDisplayValue("Reference to read"), { target: { value: "template" } });
    const f = new File(["x"], "MOU_template.docx", { lastModified: 1 });
    const zone = utils.container.querySelector('[data-component="FileDropZone"]')!;
    fireEvent.drop(zone, { dataTransfer: { files: [f] } });
    fireEvent.drop(zone, { dataTransfer: { files: [f] } });
    expect(upload).toHaveBeenCalledTimes(1);
    expect(upload.mock.calls[0][0]).toMatchObject({ slug: "mou", kind: "sample" });
    expect(utils.getByText(/Uploading 0%/)).toBeTruthy();
    release();
    await utils.findByText(/Template to match · added by you/);
    expect(utils.queryByText(/Uploading/)).toBeNull();
    expect(router.refresh).toHaveBeenCalled();
  });

  it("a failed upload stays with its reason and Retry", async () => {
    let fail = true;
    const upload = vi.fn<UploadFn>(async (req) =>
      fail
        ? ((fail = false), { ok: false, status: 502, data: null, error: "Storage is down." })
        : { ok: true, status: 200, data: { kind: req.kind, ref: "leo/mou/a.pdf", profile: "default", label: "a.pdf" }, error: null },
    );
    const utils = render(<FilesPanel project={PROJECT} upload={upload} />);
    fireEvent.change(utils.getByTestId("file-input"), {
      target: { files: [new File(["x"], "a.pdf", { lastModified: 1 })] },
    });
    await utils.findByText("✗ Storage is down.");
    fireEvent.click(utils.getByText("Retry"));
    await utils.findByText(/Reference to read · /);
    expect(upload).toHaveBeenCalledTimes(2);
    expect(upload.mock.calls[1][0].idempotencyKey).toBe(upload.mock.calls[0][0].idempotencyKey);
  });
});

describe("AddToProjectSheet", () => {
  it("double click → one POST, pending label, closes on success", async () => {
    const { fetchMock, held } = heldFetch();
    vi.stubGlobal("fetch", fetchMock);
    const onClose = vi.fn();
    const utils = render(
      <AddToProjectSheet onClose={onClose} fixedSlug="mou" prefill={{ kind: "todo", ref: "td_1" }} />,
    );
    const add = utils.getByText("Add link").closest("button")!;
    fireEvent.click(add);
    fireEvent.click(add);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect((held[0].init?.headers as Record<string, string>)["Idempotency-Key"]).toBeTruthy();
    expect(utils.getByText("Adding…")).toBeTruthy();
    expect(add.disabled).toBe(true);
    held[0].release(json(200, { kind: "todo", ref: "td_1" }));
    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
  });

  it("failure shows the reason, re-enables, and Retry re-sends the same key", async () => {
    const { fetchMock, held } = heldFetch();
    vi.stubGlobal("fetch", fetchMock);
    const onClose = vi.fn();
    const utils = render(
      <AddToProjectSheet onClose={onClose} fixedSlug="mou" prefill={{ kind: "todo", ref: "td_1" }} />,
    );
    fireEvent.click(utils.getByText("Add link"));
    held[0].release(json(500, { detail: "boom" }));
    await utils.findByText("Retry");
    expect(utils.getByText("Add link").closest("button")!.disabled).toBe(false);
    fireEvent.click(utils.getByText("Retry"));
    const key = (i: number) => (held[i].init?.headers as Record<string, string>)["Idempotency-Key"];
    expect(key(1)).toBe(key(0));
    held[1].release(json(200, {}));
    await waitFor(() => expect(onClose).toHaveBeenCalled());
  });

  it("promote posts once and navigates to the project", async () => {
    const { fetchMock, held } = heldFetch();
    vi.stubGlobal("fetch", fetchMock);
    const onClose = vi.fn();
    const utils = render(
      <AddToProjectSheet
        onClose={onClose}
        fixedSlug="mou"
        prefill={{ kind: "todo", ref: "td_1" }}
        promote={{ todoId: "td_1", todoTitle: "Draft" }}
      />,
    );
    const promote = utils.getByText("Promote to card").closest("button")!;
    fireEvent.click(promote);
    fireEvent.click(promote);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(held[0].url).toBe("/api/projects/mou/cards");
    expect(utils.getByText("Promoting…")).toBeTruthy();
    held[0].release(json(200, { task_id: "t1" }));
    await waitFor(() => expect(router.push).toHaveBeenCalledWith("/projects/mou"));
    expect(onClose).toHaveBeenCalled();
  });
});
