// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  NetworkFolders,
  buildNetworkFolderInput,
  networkFolderFormError,
} from "@/components/files/NetworkFolders";
import type { NetworkFolderView, VpnView } from "@/types";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

function vpn(over: Partial<VpnView> = {}): VpnView {
  return {
    name: "Office files",
    slug: "office-files",
    host: "vpn.example.com",
    port: 10443,
    realm: null,
    routes: ["10.20.0.0/16"],
    share_path: null,
    mount_path: null,
    auto_connect: true,
    idle_minutes: 30,
    visibility: "private:alice",
    owner_user_id: "alice",
    trusted_cert: null,
    status: {
      state: "connected",
      since: null,
      local_ip: null,
      error: null,
      last_used: null,
      last_check: null,
    },
    ...over,
  };
}

function folder(
  over: Omit<Partial<NetworkFolderView>, "status"> & {
    status?: Partial<NetworkFolderView["status"]>;
  } = {},
): NetworkFolderView {
  const { status, ...rest } = over;
  return {
    id: "net-tender-documents",
    name: "Tender documents",
    vpn: "Office files",
    vpn_slug: "office-files",
    share_path: "//fs01.office.local/Projects/Tenders",
    share_username: null,
    has_share_password: false,
    share_domain: null,
    trusted_for_import: true,
    mount_path: "/opt/data/vpn-files/net-tender-documents",
    ...rest,
    status: {
      vpn_state: "connected",
      mounted: true,
      error: null,
      last_check: null,
      ...status,
    },
  };
}

const HR_FAILED = folder({
  id: "net-hr-policies",
  name: "HR policies",
  share_path: "//fs02.office.local/HR/Policies",
  trusted_for_import: false,
  status: {
    vpn_state: "disconnected",
    mounted: false,
    error: "File share login failed: check the share username and password",
    last_check: {
      at: new Date().toISOString(),
      ok: false,
      file_count: null,
      message: "File share login failed: check the share username and password",
    },
  },
});

type Call = { method: string; url: string; body: unknown };
type Reply = { status?: number; data: unknown };

function mockApi(
  state: { folders: NetworkFolderView[]; vpns: VpnView[] },
  handlers: Record<string, (call: Call) => Reply> = {},
) {
  const calls: Call[] = [];
  vi.spyOn(globalThis, "fetch").mockImplementation(
    async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = init?.method ?? "GET";
      const body = init?.body ? JSON.parse(String(init.body)) : undefined;
      const call = { method, url, body };
      calls.push(call);
      const handler = handlers[`${method} ${url}`];
      let reply: Reply;
      if (handler) reply = handler(call);
      else if (url === "/api/vpn/folders" && method === "GET") {
        reply = { data: { folders: state.folders } };
      } else if (url === "/api/vpn") reply = { data: { vpns: state.vpns } };
      else reply = { status: 500, data: { detail: `unmocked ${method} ${url}` } };
      return new Response(JSON.stringify(reply.data), {
        status: reply.status ?? 200,
        headers: { "content-type": "application/json" },
      });
    },
  );
  return calls;
}

function fill(label: string, value: string) {
  fireEvent.change(screen.getByLabelText(label), { target: { value } });
}

async function openAddForm() {
  await waitFor(() =>
    expect(
      (screen.getByText("Add network folder", { selector: "button" }) as HTMLButtonElement)
        .disabled,
    ).toBe(false),
  );
  fireEvent.click(screen.getByText("Add network folder", { selector: "button" }));
  return document.querySelector("[data-network-folder-form]") as HTMLElement;
}

describe("helpers", () => {
  const VALUES = {
    name: " Tenders ",
    vpn: "Office files",
    share_path: "\\\\fs01\\Projects\\Tenders",
    share_username: "",
    share_password: "",
    share_domain: "",
    trusted_for_import: false,
  };

  it("accepts a file server outside the VPN's routes (Hermes adds its /32)", () => {
    expect(
      networkFolderFormError(
        { ...VALUES, share_path: "\\\\192.168.0.91\\Share-Folder\\Jensen (New)" },
        [],
      ),
    ).toBeNull();
  });

  it("needs a share username when a share password or domain is given", () => {
    expect(networkFolderFormError({ ...VALUES, share_password: "x" }, [])).toMatch(
      /Enter the share username/,
    );
    expect(networkFolderFormError({ ...VALUES, share_domain: "OFFICE" }, [])).toMatch(
      /Enter the share username/,
    );
    expect(networkFolderFormError({ ...VALUES, share_username: "alice" }, [])).toBeNull();
  });

  it("sends no login fields when the share username is blank", () => {
    const values = { ...VALUES, share_username: "  " };
    expect(buildNetworkFolderInput(values)).toEqual({
      name: "Tenders",
      vpn: "Office files",
      share_path: "//fs01/Projects/Tenders",
      trusted_for_import: false,
      share_username: null,
      share_domain: null,
    });
    const own = { ...values, share_username: " alice ", share_domain: "OFFICE" };
    expect(buildNetworkFolderInput(own)).toMatchObject({
      share_username: "alice",
      share_domain: "OFFICE",
    });
    expect(buildNetworkFolderInput(own)).not.toHaveProperty("share_password");
    expect(buildNetworkFolderInput({ ...own, share_password: "s3cret" })).toMatchObject({
      share_password: "s3cret",
    });
  });
});

describe("NetworkFolders", () => {
  it("lists a connected folder and a failed one with its error line", async () => {
    mockApi({ folders: [folder(), HR_FAILED], vpns: [vpn()] });
    render(<NetworkFolders />);
    const tender = (await screen.findByText("Tender documents")).closest("li")!;
    expect(tender.getAttribute("data-mounted")).toBe("true");
    expect(tender.textContent).toContain("\\\\fs01.office.local\\Projects\\Tenders · via Office files");
    expect(within(tender).getByText("VPN connected")).toBeTruthy();
    expect(within(tender).getByText("Trusted for import")).toBeTruthy();
    for (const b of ["Test", "Edit", "Remove"]) expect(within(tender).getByText(b)).toBeTruthy();

    const hr = screen.getByText("HR policies").closest("li")!;
    expect(hr.getAttribute("data-mounted")).toBe("false");
    expect(within(hr).getByText("VPN off")).toBeTruthy();
    expect(within(hr).queryByText("Trusted for import")).toBeNull();

    const alert = screen.getByRole("alert");
    expect(alert.textContent).toMatch(/^HR policies — last test \d\d:\d\d/);
    expect(alert.textContent).toContain("File share login failed");
  });

  it("re-tests a row and shows the new result", async () => {
    const calls = mockApi(
      { folders: [HR_FAILED], vpns: [vpn()] },
      {
        "POST /api/vpn/folders/HR%20policies/test": () => ({
          data: { ...HR_FAILED, status: { ...folder().status, mounted: true } },
        }),
      },
    );
    render(<NetworkFolders />);
    await screen.findByRole("alert");
    fireEvent.click(screen.getByText("Test"));
    await waitFor(() => expect(screen.queryByRole("alert")).toBeNull());
    expect(calls.some((c) => c.method === "POST" && c.url.endsWith("/test"))).toBe(true);
    expect(screen.getByText("HR policies").closest("li")!.getAttribute("data-mounted")).toBe(
      "true",
    );
  });

  it("shows an empty state linking to Settings → In&Out when there is no VPN", async () => {
    mockApi({ folders: [], vpns: [] });
    render(<NetworkFolders />);
    const empty = await screen.findByText(/need a VPN to the office/);
    const link = within(empty.closest("p")!).getByRole("link");
    expect(link.getAttribute("href")).toBe("/settings#in-out");
    expect(
      (screen.getByText("Add network folder", { selector: "button" }) as HTMLButtonElement)
        .disabled,
    ).toBe(true);
  });

  it("offers only the caller's VPNs in the selector", async () => {
    mockApi({
      folders: [],
      vpns: [vpn(), vpn({ name: "Branch office", slug: "branch-office", host: "b.example.com", port: 443 })],
    });
    render(<NetworkFolders />);
    const form = await openAddForm();
    const options = within(form).getAllByRole("option").map((o) => o.textContent);
    expect(options).toEqual(["Office files — vpn.example.com:10443", "Branch office — b.example.com"]);
    expect((within(form).getByLabelText("VPN connection") as HTMLSelectElement).value).toBe(
      "Office files",
    );
    expect(form.textContent).toContain("Only this file server is sent through the VPN.");
    expect(form.textContent).not.toContain("routes");
    expect(form.textContent).toContain(
      "Share login (optional) — leave blank to use the VPN's login",
    );
  });

  it.each([
    [{ name: "", path: "\\\\fs01\\Projects" }, /Give the folder a name/],
    [{ name: "Tender documents", path: "\\\\fs01\\Projects" }, /already exists/],
    [{ name: "New", path: "fs01\\Projects" }, /must look like/],
  ])("blocks an invalid add %j", async ({ name, path }, msg) => {
    const calls = mockApi({ folders: [folder()], vpns: [vpn()] });
    render(<NetworkFolders />);
    await openAddForm();
    fill("Name shown to the agent", name);
    fill("SMB path", path);
    fireEvent.click(screen.getByText("Save & test"));
    expect(screen.getByRole("alert").textContent).toMatch(msg);
    expect(calls.some((c) => c.method !== "GET")).toBe(false);
  });

  it("saves a folder whose server is outside the VPN's routes", async () => {
    const saved = folder({
      name: "Jensen",
      share_path: "//192.168.0.91/Share-Folder/Jensen (New)",
      status: { mounted: false, vpn_state: "disconnected" },
    });
    const calls = mockApi(
      { folders: [], vpns: [vpn({ routes: [] })] },
      {
        "POST /api/vpn/folders": () => ({ status: 201, data: saved }),
        "POST /api/vpn/folders/Jensen/test": () => ({
          data: {
            ...saved,
            status: {
              ...saved.status,
              mounted: true,
              last_check: {
                at: new Date().toISOString(),
                ok: true,
                file_count: 5000,
                message: "File server reachable, at least 5000 files (stopped counting after 20 s).",
              },
            },
          },
        }),
      },
    );
    render(<NetworkFolders />);
    await openAddForm();
    fill("Name shown to the agent", "Jensen");
    fill("SMB path", "\\\\192.168.0.91\\Share-Folder\\Jensen (New)");
    fireEvent.click(screen.getByText("Save & test"));
    const result = await screen.findByText(/Test OK:/);
    expect(result.textContent).toContain(
      "File server reachable, at least 5000 files (stopped counting after 20 s).",
    );
    const post = calls.find((c) => c.method === "POST" && c.url === "/api/vpn/folders")!;
    expect(post.body).toMatchObject({
      share_path: "//192.168.0.91/Share-Folder/Jensen (New)",
      share_username: null,
      share_domain: null,
    });
  });

  it("shows Hermes' failed check message as-is on the row", async () => {
    const ok = false;
    const message = "File server is too slow to answer (no reply within 25 s).";
    const tested = folder({
      status: {
        mounted: ok,
        last_check: { at: new Date().toISOString(), ok, file_count: ok ? 214 : null, message },
      },
    });
    mockApi(
      { folders: [folder()], vpns: [vpn()] },
      { "POST /api/vpn/folders/Tender%20documents/test": () => ({ data: tested }) },
    );
    render(<NetworkFolders />);
    fireEvent.click(await screen.findByText("Test"));
    await waitFor(() => expect(screen.getByRole("alert").textContent).toContain(message));
  });

  it("requires a username when a share password is entered", async () => {
    mockApi({ folders: [], vpns: [vpn()] });
    render(<NetworkFolders />);
    await openAddForm();
    fill("Name shown to the agent", "Tenders");
    fill("SMB path", "\\\\fs01\\Projects");
    fill("Share password", "s3cret");
    fireEvent.click(screen.getByText("Save & test"));
    expect(screen.getByRole("alert").textContent).toMatch(/Enter the share username/);
  });

  it("saves a normalised path, tests it and shows Test OK", async () => {
    const saved = folder({ status: { mounted: false, vpn_state: "disconnected" } });
    const calls = mockApi(
      { folders: [], vpns: [vpn()] },
      {
        "POST /api/vpn/folders": () => ({ status: 201, data: saved }),
        "POST /api/vpn/folders/Tender%20documents/test": () => ({
          data: folder({
            status: {
              last_check: {
                at: new Date().toISOString(),
                ok: true,
                file_count: 214,
                message: "File server reachable, 214 files listed.",
              },
            },
          }),
        }),
      },
    );
    render(<NetworkFolders />);
    await openAddForm();
    fill("Name shown to the agent", "Tender documents");
    fill("SMB path", "\\\\fs01.office.local\\Projects\\Tenders\\");
    fill("Share username", "alice");
    fill("Share password", "s3cret");
    fill("Domain (optional)", "OFFICE");
    fireEvent.click(screen.getByLabelText(/Trusted for import/));
    fireEvent.click(screen.getByText("Save & test"));

    const result = await screen.findByText(/Test OK:/);
    expect(result.closest("[data-component='NetworkFolderTestResult']")!.getAttribute("data-ok")).toBe(
      "true",
    );
    expect(result.textContent).toBe("✓ Test OK: File server reachable, 214 files listed.");
    const post = calls.find((c) => c.method === "POST" && c.url === "/api/vpn/folders")!;
    expect(post.body).toEqual({
      name: "Tender documents",
      vpn: "Office files",
      share_path: "//fs01.office.local/Projects/Tenders",
      share_username: "alice",
      share_password: "s3cret",
      share_domain: "OFFICE",
      trusted_for_import: true,
    });
    // The row appears without a reload, and the form now just closes.
    expect(screen.getByText("Tender documents", { selector: "span" }).closest("li")).toBeTruthy();
    expect(screen.getByText("Close")).toBeTruthy();
    expect((screen.getByLabelText("Share password") as HTMLInputElement).value).toBe("");
  });

  it("shows a failed Save & test in the form and on the row", async () => {
    mockApi(
      { folders: [], vpns: [vpn()] },
      {
        "POST /api/vpn/folders": () => ({ status: 201, data: { ...HR_FAILED, status: folder().status } }),
        "POST /api/vpn/folders/HR%20policies/test": () => ({ data: HR_FAILED }),
      },
    );
    render(<NetworkFolders />);
    await openAddForm();
    fill("Name shown to the agent", "HR policies");
    fill("SMB path", "smb://fs02.office.local/HR/Policies");
    fireEvent.click(screen.getByText("Save & test"));
    const result = await screen.findByText(/Test failed:/);
    expect(result.textContent).toContain("File share login failed");
    expect(screen.getByRole("alert").textContent).toMatch(/^HR policies — last test/);
  });

  it("shows Hermes' 400 detail and keeps the form open", async () => {
    mockApi(
      { folders: [], vpns: [vpn()] },
      {
        "POST /api/vpn/folders": () => ({
          status: 400,
          data: { detail: "File server fs09 is not reachable through the VPN" },
        }),
      },
    );
    render(<NetworkFolders />);
    await openAddForm();
    fill("Name shown to the agent", "X");
    fill("SMB path", "\\\\fs09\\X");
    fireEvent.click(screen.getByText("Save & test"));
    expect((await screen.findByRole("alert")).textContent).toContain("not reachable through the VPN");
    expect(screen.getByText("Cancel")).toBeTruthy();
  });

  it("edits with a blank password (kept) and can rename", async () => {
    const stored = folder({ share_username: "alice", has_share_password: true, share_domain: "OFFICE" });
    const calls = mockApi(
      { folders: [stored], vpns: [vpn()] },
      {
        "PUT /api/vpn/folders/Tender%20documents": (c) => ({
          data: { ...stored, name: (c.body as { name: string }).name },
        }),
        "POST /api/vpn/folders/Tenders%202026/test": () => ({
          data: { ...stored, name: "Tenders 2026" },
        }),
      },
    );
    render(<NetworkFolders />);
    fireEvent.click(await screen.findByText("Edit"));
    expect((screen.getByLabelText("SMB path") as HTMLInputElement).value).toBe(
      "\\\\fs01.office.local\\Projects\\Tenders",
    );
    expect((screen.getByLabelText("Share username") as HTMLInputElement).value).toBe("alice");
    expect(screen.getByLabelText("Share password").getAttribute("placeholder")).toBe("unchanged");
    fill("Name shown to the agent", "Tenders 2026");
    fireEvent.click(screen.getByText("Save & test"));
    await screen.findByText(/Test OK:/);
    const put = calls.find((c) => c.method === "PUT")!;
    expect(put.url).toBe("/api/vpn/folders/Tender%20documents");
    expect(put.body).not.toHaveProperty("share_password");
    expect(put.body).toMatchObject({ name: "Tenders 2026", share_username: "alice", share_domain: "OFFICE" });
    expect(screen.queryByText("Tender documents", { selector: "span" })).toBeNull();
    expect(screen.getByText("Tenders 2026", { selector: "span" })).toBeTruthy();
  });

  it("removes a folder after confirmation", async () => {
    const calls = mockApi(
      { folders: [folder(), HR_FAILED], vpns: [vpn()] },
      { "DELETE /api/vpn/folders/Tender%20documents": () => ({ data: { ok: true } }) },
    );
    render(<NetworkFolders />);
    const row = (await screen.findByText("Tender documents")).closest("li")!;
    fireEvent.click(within(row).getByText("Remove"));
    const dialog = screen.getByRole("dialog");
    expect(dialog.textContent).toContain("\\\\fs01.office.local\\Projects\\Tenders");
    expect(calls.some((c) => c.method === "DELETE")).toBe(false);
    fireEvent.click(within(dialog).getByText("Remove"));
    await waitFor(() => expect(screen.queryByText("Tender documents")).toBeNull());
    expect(screen.getByText("HR policies")).toBeTruthy();
  });

  it("says so when the folder list can't load", async () => {
    mockApi(
      { folders: [], vpns: [vpn()] },
      { "GET /api/vpn/folders": () => ({ status: 502, data: {} }) },
    );
    render(<NetworkFolders />);
    expect(await screen.findByText("Could not load network folders.")).toBeTruthy();
  });
});
