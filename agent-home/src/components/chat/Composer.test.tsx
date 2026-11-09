// @vitest-environment jsdom
/**
 * Oversized-file upload confirmation: files over the advisory 100 MB
 * threshold pause at an "Upload anyway" prompt rather than being refused.
 */
import { cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { Composer } from "@/components/chat/Composer";
import { __resetUploadLimit } from "@/lib/chat/upload-limit-client";

/** A File whose declared size is faked — no 100 MB allocation needed. */
function fakeFile(name: string, size: number): File {
  const f = new File(["x"], name);
  Object.defineProperty(f, "size", { value: size });
  return f;
}

afterEach(() => {
  cleanup();
  __resetUploadLimit();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function pick(file: File) {
  const input = document.querySelector('input[type="file"]') as HTMLInputElement;
  fireEvent.change(input, { target: { files: [file] } });
}

/** fetch stub: the limit lookup answers `limit`, uploads answer `attachment`. */
function routedFetch(attachment: object, limit = 1024 ** 3) {
  return vi.fn(async (url: string) =>
    url === "/api/settings/uploads"
      ? new Response(JSON.stringify({ max_bytes: limit, legacy_override_bytes: null }))
      : new Response(JSON.stringify(attachment), { status: 200 }),
  );
}

const uploadCalls = (fetchMock: ReturnType<typeof vi.fn>) =>
  fetchMock.mock.calls.filter((call) => call[0] === "/api/chat/upload");

describe("Composer draft restore", () => {
  it("puts the text back when onSend reports a transport failure", async () => {
    const { getByRole, getByPlaceholderText } = render(
      <Composer
        sending={false}
        storageEnabled={false}
        sessionId="s1"
        onSend={() => Promise.resolve(false)}
      />,
    );
    const box = getByPlaceholderText(/Message your agent/);
    fireEvent.change(box, { target: { value: "lost on the wire" } });
    fireEvent.click(getByRole("button", { name: "Send" }));
    await waitFor(() =>
      expect((box as HTMLTextAreaElement).value).toBe("lost on the wire"),
    );
  });

  it("clears the text for good when onSend resolves true", async () => {
    const { getByRole, getByPlaceholderText } = render(
      <Composer
        sending={false}
        storageEnabled={false}
        sessionId="s1"
        onSend={() => Promise.resolve(true)}
      />,
    );
    const box = getByPlaceholderText(/Message your agent/);
    fireEvent.change(box, { target: { value: "delivered" } });
    fireEvent.click(getByRole("button", { name: "Send" }));
    await waitFor(() =>
      expect((box as HTMLTextAreaElement).value).toBe(""),
    );
  });
});

describe("Composer oversized uploads", () => {
  it("uploads a small file without confirmation", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ path: "p", name: "a.txt" }), {
        status: 200,
      }),
    );
    vi.stubGlobal("fetch", fetchMock);
    render(
      <Composer
        sending={false}
        storageEnabled
        sessionId="s1"
        onSend={() => {}}
      />,
    );
    const input = document.querySelector(
      'input[type="file"]',
    ) as HTMLInputElement;
    fireEvent.change(input, { target: { files: [fakeFile("a.txt", 8)] } });
    await waitFor(() => expect(fetchMock).toHaveBeenCalledOnce());
    expect(
      document.querySelector('[data-component="OversizeConfirm"]'),
    ).toBeNull();
  });

  it("asks before uploading a file over 100 MB, then proceeds", async () => {
    const fetchMock = routedFetch({ path: "p", name: "big.zip" });
    vi.stubGlobal("fetch", fetchMock);
    const { getByText, findByText } = render(
      <Composer
        sending={false}
        storageEnabled
        sessionId="s1"
        onSend={() => {}}
      />,
    );
    const input = document.querySelector(
      'input[type="file"]',
    ) as HTMLInputElement;
    fireEvent.change(input, {
      target: { files: [fakeFile("big.zip", 101 * 1024 * 1024)] },
    });
    // Pauses for confirmation — no upload yet.
    await findByText("Upload anyway");
    expect(uploadCalls(fetchMock)).toHaveLength(0);
    fireEvent.click(getByText("Upload anyway"));
    await waitFor(() => expect(uploadCalls(fetchMock)).toHaveLength(1));
  });

  it("cancel leaves the file unuploaded", async () => {
    const fetchMock = routedFetch({});
    vi.stubGlobal("fetch", fetchMock);
    const { findByText, getByText, queryByText } = render(
      <Composer
        sending={false}
        storageEnabled
        sessionId="s1"
        onSend={() => {}}
      />,
    );
    const input = document.querySelector(
      'input[type="file"]',
    ) as HTMLInputElement;
    fireEvent.change(input, {
      target: { files: [fakeFile("big.zip", 101 * 1024 * 1024)] },
    });
    await findByText("Cancel");
    fireEvent.click(getByText("Cancel"));
    expect(queryByText("Upload anyway")).toBeNull();
    expect(uploadCalls(fetchMock)).toHaveLength(0);
  });

  it("refuses a file over the configured limit before uploading it", async () => {
    const fetchMock = routedFetch({ path: "p" }, 50 * 1024 * 1024);
    vi.stubGlobal("fetch", fetchMock);
    const { findByText } = render(
      <Composer sending={false} storageEnabled sessionId="s1" onSend={() => {}} />,
    );
    pick(fakeFile("video.mov", 60 * 1024 * 1024));
    await findByText("video.mov: over the 50 MB upload limit.");
    expect(uploadCalls(fetchMock)).toHaveLength(0);
  });
});

describe("Composer upload errors", () => {
  async function failWith(res: Response | Error): Promise<string> {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        if (res instanceof Error) throw res;
        return res;
      }),
    );
    render(<Composer sending={false} storageEnabled sessionId="s1" onSend={() => {}} />);
    pick(fakeFile("shot.png", 8));
    let text = "";
    await waitFor(() => {
      text = document.querySelector("p[class*=\"--color-danger\"]")?.textContent ?? "";
      expect(text).not.toBe("");
    });
    return text;
  }

  it("shows the server detail with the HTTP status and error code", async () => {
    const text = await failWith(
      new Response(JSON.stringify({ error: "invalid_form", detail: "The upload arrived incomplete." }), {
        status: 400,
      }),
    );
    expect(text).toBe("shot.png: The upload arrived incomplete. (HTTP 400, invalid_form)");
  });

  it("handles a non-JSON error page (a proxy 502)", async () => {
    const text = await failWith(
      new Response("<html><body>Bad Gateway</body></html>", {
        status: 502,
        headers: { "content-type": "text/html" },
      }),
    );
    expect(text).toBe("shot.png: Upload failed: the server sent an unexpected response. (HTTP 502)");
  });

  it("handles an empty error body", async () => {
    const text = await failWith(new Response(null, { status: 500 }));
    expect(text).toBe("shot.png: Upload failed: the server sent no details. (HTTP 500)");
  });

  it("shows the error code when there is no detail", async () => {
    const text = await failWith(new Response(JSON.stringify({ error: "invalid_form" }), { status: 400 }));
    expect(text).toBe("shot.png: Upload failed. (HTTP 400, invalid_form)");
  });

  it("treats a 200 with a non-JSON body as a failure, not an attachment", async () => {
    const text = await failWith(new Response("OK", { status: 200 }));
    expect(text).toBe("shot.png: Upload failed: the server sent an unexpected response. (HTTP 200)");
  });

  it("says when the server could not be reached", async () => {
    const text = await failWith(new TypeError("Failed to fetch"));
    expect(text).toBe("shot.png: Upload failed: the server could not be reached (Failed to fetch).");
  });
});

describe("Composer Stop button", () => {
  it("is ready to press while the turn started by a Send click is still running", async () => {
    const onStop = vi.fn();
    const props = {
      storageEnabled: false,
      sessionId: "s1",
      onStop,
      onSend: () => new Promise<boolean>(() => {}),
    };
    const { getByRole, getByPlaceholderText, rerender } = render(
      <Composer sending={false} {...props} />,
    );
    fireEvent.change(getByPlaceholderText(/Message your agent/), {
      target: { value: "hello" },
    });
    fireEvent.click(getByRole("button", { name: "Send" }));
    rerender(<Composer sending {...props} />);
    const stop = getByRole("button", { name: "Stop the agent" });
    expect((stop as HTMLButtonElement).disabled).toBe(false);
    expect(stop.getAttribute("data-busy")).toBe("false");
    fireEvent.click(stop);
    expect(onStop).toHaveBeenCalledTimes(1);
  });
});
