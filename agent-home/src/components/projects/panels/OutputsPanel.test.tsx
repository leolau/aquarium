// @vitest-environment jsdom
/**
 * Interaction tests for the Outputs panel's delivery rows: a `file` delivery
 * must give the reviewer a way to open the artefact (registry detail when the
 * path resolves, a media-content fallback when it does not), a `url` delivery
 * is a plain external link, and ref-less kinds stay text.
 */
import { cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("next/navigation", () => ({
  usePathname: () => "/projects",
  useRouter: () => ({ refresh: () => {}, push: () => {} }),
}));

import { OutputsPanel } from "@/components/projects/panels/OutputsPanel";
import type {
  FileAsset,
  ProjectDelivery,
  ProjectOutputWithDeliveries,
} from "@/types";

const NOW = Math.floor(Date.now() / 1000);

const DELIVERY = (over: Partial<ProjectDelivery>): ProjectDelivery => ({
  id: "del_1",
  output_id: "out_1",
  run_id: "run_1",
  task_id: null,
  link_kind: null,
  link_ref: null,
  profile: "default",
  label: null,
  note: null,
  delivered_at: NOW,
  ...over,
});

const OUTPUT = (
  deliveries: ProjectDelivery[],
  over: Partial<ProjectOutputWithDeliveries> = {},
): ProjectOutputWithDeliveries => ({
  id: "out_1",
  project_id: "prj_1",
  seq: 1,
  title: "The slide deck",
  spec: null,
  kind: "artifact",
  required: 1,
  recurring: 1,
  status: "delivered",
  delivered_at: NOW,
  accepted_at: null,
  accepted_by: null,
  created_at: NOW,
  deliveries,
  ...over,
});

const ASSET: FileAsset = {
  id: "file_9",
  owner_user_id: "leo",
  visibility: "private",
  surface: "agent_home",
  account_id: null,
  conversation: null,
  sender_id: null,
  sender_name: null,
  message_id: null,
  received_at: null,
  filename: "Deck.pdf",
  content_type: "application/pdf",
  byte_size: 2048,
  sha256: "abc",
  storage_path: "leo/canva/123e4567-e89b-42d3-a456-426614174000-Deck.pdf",
  document_id: null,
  remembered_at: null,
  remembered_by: null,
  remembered: false,
};

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("OutputsPanel deliveries", () => {
  it("renders a file delivery as an openable file name", () => {
    const html = renderToStaticMarkup(
      <OutputsPanel
        slug="canva-deck"
        outputs={[
          OUTPUT([
            DELIVERY({
              link_kind: "file",
              link_ref: "leo/canva/123e4567-e89b-42d3-a456-426614174000-Deck.pdf",
            }),
          ]),
        ]}
      />,
    );
    expect(html).toContain("aria-label=\"Open Deck.pdf\"");
    expect(html).toContain("Deck.pdf");
  });

  it("resolves a file delivery to the registry detail with view/download", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify(ASSET), { status: 200 }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const { getByLabelText, findByRole, getByText } = render(
      <OutputsPanel
        slug="canva-deck"
        outputs={[
          OUTPUT([
            DELIVERY({
              link_kind: "file",
              link_ref: "leo/canva/123e4567-e89b-42d3-a456-426614174000-Deck.pdf",
              label: "Deck.pdf",
            }),
          ]),
        ]}
      />,
    );

    fireEvent.click(getByLabelText("Open Deck.pdf"));
    await waitFor(() =>
      expect(fetchMock).toHaveBeenCalledWith(
        "/api/files/by-path?path=leo%2Fcanva%2F123e4567-e89b-42d3-a456-426614174000-Deck.pdf",
      ),
    );

    const dialog = await findByRole("dialog");
    expect(dialog.getAttribute("aria-label")).toBe("Deck.pdf");
    expect(getByText("View").getAttribute("href")).toBe(
      "/api/files/file_9/content",
    );
    expect(getByText("Download").getAttribute("href")).toBe(
      "/api/files/file_9/content?download=1",
    );
  });

  it("falls back to the media content route when the registry misses", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(new Response("nope", { status: 404 })),
    );

    const { getByLabelText, findByRole, getByText } = render(
      <OutputsPanel
        slug="canva-deck"
        outputs={[
          OUTPUT([
            DELIVERY({
              link_kind: "file",
              link_ref: "leo/canva/123e4567-e89b-42d3-a456-426614174000-Deck.pdf",
            }),
          ]),
        ]}
      />,
    );

    fireEvent.click(getByLabelText("Open Deck.pdf"));
    await findByRole("dialog");
    const view = getByText("View");
    expect(view.getAttribute("href")).toBe(
      "/api/chat/media/content?path=leo%2Fcanva%2F123e4567-e89b-42d3-a456-426614174000-Deck.pdf",
    );
    expect(getByText("Download").getAttribute("href")).toBe(
      "/api/chat/media/content?path=leo%2Fcanva%2F123e4567-e89b-42d3-a456-426614174000-Deck.pdf&download=1",
    );
  });

  it("renders a url delivery as an external link", () => {
    const html = renderToStaticMarkup(
      <OutputsPanel
        slug="canva-deck"
        outputs={[
          OUTPUT([
            DELIVERY({
              link_kind: "url",
              link_ref: "https://canva.com/design/xyz",
              label: "Canva deck",
            }),
          ]),
        ]}
      />,
    );
    expect(html).toContain('href="https://canva.com/design/xyz"');
    expect(html).toContain('target="_blank"');
    expect(html).toContain("Canva deck");
  });

  it("keeps ref-less and non-file deliveries as plain text", () => {
    const html = renderToStaticMarkup(
      <OutputsPanel
        slug="canva-deck"
        outputs={[
          OUTPUT([
            DELIVERY({ label: "pasted into chat" }),
            DELIVERY({ id: "del_2", link_kind: "memory", link_ref: "mem_7" }),
          ]),
        ]}
      />,
    );
    expect(html).toContain("pasted into chat");
    expect(html).toContain("mem_7");
    expect(html).not.toContain("aria-label=\"Open");
  });
});
