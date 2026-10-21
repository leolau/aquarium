// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { Composer } from "@/components/chat/Composer";
import { ApprovalCard } from "@/components/chat/thread/ApprovalCard";
import { TodoCompleteForm } from "@/components/todos/TodoCompleteForm";
import type { ChatApprovalRequest, TodoDetail } from "@/types";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

function deferred<T = void>() {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

describe("busy buttons — chat, inbox, to-dos", () => {
  it("Composer: Enter pressed twice and a Send click send the message once", async () => {
    const turn = deferred<boolean>();
    const onSend = vi.fn(() => turn.promise);
    render(<Composer sending={false} storageEnabled={false} sessionId={null} onSend={onSend} />);
    const box = screen.getByPlaceholderText(/Message your agent/);
    fireEvent.change(box, { target: { value: "hello" } });
    fireEvent.keyDown(box, { key: "Enter" });
    fireEvent.keyDown(box, { key: "Enter" });
    expect(onSend).toHaveBeenCalledTimes(1);
    await act(async () => turn.resolve(true));
  });

  it("ApprovalCard: a choice shows Submitting… and blocks every choice while busy", () => {
    const request: ChatApprovalRequest = {
      runId: "run-1",
      command: "ls",
      description: "",
      choices: ["deny", "once"],
    };
    const onResolve = vi.fn(() => new Promise(() => {}));
    render(<ApprovalCard request={request} busy={false} onResolve={onResolve} />);
    const approve = screen.getByRole("button", { name: "Approve" });
    fireEvent.click(approve);
    fireEvent.click(approve);
    fireEvent.click(approve);
    expect(onResolve).toHaveBeenCalledTimes(1);
    expect(approve.textContent).toBe("Submitting…");
    expect(approve.hasAttribute("disabled")).toBe(true);
  });

  it("TodoCompleteForm: Finish posts once and says Finishing… until the server answers", async () => {
    const answer = deferred<Response>();
    const fetchMock = vi.spyOn(globalThis, "fetch").mockReturnValue(answer.promise);
    const todo = { id: "t1", title: "Call Amy", stage: "open", source: null } as unknown as TodoDetail;
    render(<TodoCompleteForm todo={todo} onDone={() => {}} />);
    fireEvent.click(screen.getByRole("button", { name: "Mark done…" }));
    const finish = screen.getByRole("button", { name: "Finish" });
    fireEvent.click(finish);
    fireEvent.click(finish);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(finish.textContent).toBe("Finishing…");
    expect(finish.getAttribute("aria-busy")).toBe("true");
    await act(async () =>
      answer.resolve(new Response(JSON.stringify({ detail: "nope" }), { status: 500 })),
    );
    expect(finish.hasAttribute("disabled")).toBe(false);
  });
});
