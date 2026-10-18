// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { FolderBridgeView } from "@/components/files/FolderBridgeView";

const pickerSupported = vi.fn(() => true);

vi.mock("@/lib/folder-bridge/handles", () => ({
  addFolder: vi.fn(),
  fileSystemAccessSupported: () => true,
  folderPickerSupported: () => pickerSupported(),
  getFolderHandle: vi.fn(),
  reapproveFolder: vi.fn(),
  removeFolder: vi.fn(),
  restoreFolders: async () => [],
  setFolderTrusted: vi.fn(),
}));

vi.mock("@/lib/folder-bridge/transport", () => ({
  connectFolderBridge: vi.fn(),
  disconnectFolderBridge: vi.fn(),
  getImportProgress: () => null,
  getStatus: () => "disconnected",
  subscribeImportProgress: () => () => {},
  subscribeStatus: () => () => {},
}));

const TENDER = {
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
  status: { vpn_state: "connected", mounted: true, error: null, last_check: null },
};

beforeEach(() => {
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input: RequestInfo | URL) => {
    const url = String(input);
    const data =
      url === "/api/vpn/folders"
        ? { folders: [TENDER] }
        : { vpns: [{ name: "Office files", host: "vpn.example.com", port: 443, routes: [] }] };
    return new Response(JSON.stringify(data), { status: 200 });
  });
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  pickerSupported.mockReturnValue(true);
});

describe("FolderBridgeView network folders", () => {
  it("lists network folders while the browser bridge is disconnected", async () => {
    render(<FolderBridgeView />);
    expect(screen.getByText("Disconnected")).toBeTruthy();
    expect(screen.getByText("Folders on this Mac")).toBeTruthy();
    expect(await screen.findByText("Tender documents")).toBeTruthy();
    expect(screen.getByText("Network folders (through a VPN)")).toBeTruthy();
  });

  it("marks the consent controls as user-only for app-mcp (F18)", async () => {
    render(<FolderBridgeView />);
    await screen.findByText("Tender documents");
    for (const name of ["Connect", "Add folder"]) {
      const button = screen.getByRole("button", { name });
      expect(button.closest("[data-appmcp-deny]")).not.toBeNull();
    }
  });

  it("still shows network folders in a browser without a folder picker", async () => {
    pickerSupported.mockReturnValue(false);
    render(<FolderBridgeView />);
    expect(screen.getByText(/network folders below still work/)).toBeTruthy();
    expect(await screen.findByText("Tender documents")).toBeTruthy();
    expect(screen.queryByText("Folders on this Mac")).toBeNull();
  });
});
