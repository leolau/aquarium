// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

const router = vi.hoisted(() => ({ push: vi.fn(), refresh: vi.fn() }));
vi.mock("next/navigation", () => ({
  usePathname: () => "/projects", useRouter: () => router }));

import { project } from "@/components/projects/dashboard/__fixtures__/dashboard";
import {
  answeredState,
  clarifyState,
  confirmedState,
  openState,
} from "@/components/projects/scope/__fixtures__/clarify";
import { ScopeTab } from "@/components/projects/tabs/ScopeTab";
import type { ProjectTabProps } from "@/components/projects/tabs/types";
import { IDEMPOTENCY_HEADER } from "@/components/projects/useProjectAction";
import type { ClarifyConfirmResult, ClarifyState } from "@/types";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.useRealTimers();
  router.refresh.mockClear();
});

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => (resolve = r));
  return { promise, resolve };
}

const BASE = "/api/projects/mou-set/clarify";

type Post = (url: string, body: unknown) => Response | Promise<Response>;

/** A fake BFF: GETs answer `reads` in turn (the last one repeats), POSTs go to `post`. */
function server(reads: (ClarifyState | Response)[], post: Post = () => json(500, {})) {
  const queue = [...reads];
  const fetchMock = vi.fn((url: string, init?: RequestInit) => {
    if (!init?.method || init.method === "GET") {
      const next = queue.length > 1 ? queue.shift()! : queue[0];
      return Promise.resolve(next instanceof Response ? next.clone() : json(200, next));
    }
    return Promise.resolve(post(url, init.body ? JSON.parse(String(init.body)) : undefined));
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

function posts(fetchMock: ReturnType<typeof vi.fn>) {
  return fetchMock.mock.calls
    .map(([url, init]) => ({ url: url as string, init: init as RequestInit | undefined }))
    .filter((c) => c.init?.method === "POST")
    .map((c) => ({
      url: c.url,
      body: c.init!.body ? JSON.parse(String(c.init!.body)) : undefined,
      key: (c.init!.headers as Record<string, string>)[IDEMPOTENCY_HEADER],
    }));
}

function gets(fetchMock: ReturnType<typeof vi.fn>) {
  return fetchMock.mock.calls.filter(([, init]) => !(init as RequestInit | undefined)?.method).length;
}

function props(over: Partial<ProjectTabProps> = {}): ProjectTabProps {
  return {
    project: project(),
    board: null,
    playbook: null,
    directives: null,
    doctor: null,
    callerUserId: "yan",
    canLead: true,
    readiness: [],
    runnable: true,
    onNavigate: vi.fn(),
    onChangeRequest: vi.fn(),
    ...over,
  };
}

async function flush() {
  await act(async () => {});
}

function card(id: string) {
  return within(document.querySelector(`[data-question-id="${id}"]`) as HTMLElement);
}

const answerOf = (id: string) => (card(id).getByRole("textbox") as HTMLTextAreaElement).value;

describe("loading and not started", () => {
  it("shows a skeleton until the first read lands, then the hero", async () => {
    const d = deferred<Response>();
    vi.stubGlobal("fetch", vi.fn(() => d.promise));
    const { container } = render(<ScopeTab {...props()} />);
    expect(container.querySelector('[data-component="ClarifyLoading"]')).not.toBeNull();
    await act(async () => d.resolve(json(200, clarifyState())));
    expect(screen.getByText("Before the agent plans, let it ask about scope")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Ask me questions" })).toBeTruthy();
  });

  it("shows the hero at once from a not-started summary", () => {
    vi.stubGlobal("fetch", vi.fn(() => new Promise(() => {})));
    render(<ScopeTab {...props({ project: project({ clarify: { ...clarifyState(), status: "not_started" } }) })} />);
    expect(screen.getByText("Before the agent plans, let it ask about scope")).toBeTruthy();
  });

  it("a failed first read offers Try again", async () => {
    const fetchMock = server([json(500, { detail: "down" }), clarifyState()]);
    render(<ScopeTab {...props()} />);
    await flush();
    expect(screen.getByRole("alert").textContent).toContain("Could not load");
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    await flush();
    expect(gets(fetchMock)).toBe(2);
    expect(screen.getByRole("button", { name: "Ask me questions" })).toBeTruthy();
  });

  it("Skip — go to the plan just navigates", async () => {
    server([clarifyState()]);
    const p = props();
    render(<ScopeTab {...p} />);
    await flush();
    fireEvent.click(screen.getByRole("button", { name: "Skip — go to the plan" }));
    expect(p.onNavigate).toHaveBeenCalledWith("plan");
  });
});

describe("asking and polling", () => {
  it("posts the focus once on a double click, shows the running state, polls every 2s and stops", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const running = clarifyState({ job: { status: "running", started_at: 1 } });
    const ask = deferred<Response>();
    const fetchMock = server(
      [clarifyState(), running, openState({ job: { status: "done", round_no: 1 } })],
      () => ask.promise,
    );
    render(<ScopeTab {...props()} />);
    await flush();

    fireEvent.change(screen.getByLabelText(/Anything it should focus on/), {
      target: { value: "  the deadline " },
    });
    const button = screen.getByRole("button", { name: "Ask me questions" });
    fireEvent.click(button);
    fireEvent.click(button);
    expect(posts(fetchMock)).toHaveLength(1);
    expect(screen.getByRole("button", { name: "Asking…" })).toHaveProperty("disabled", true);
    await act(async () => ask.resolve(json(200, running)));

    expect(posts(fetchMock)).toEqual([
      { url: `${BASE}/questions`, body: { focus: "the deadline" }, key: expect.any(String) },
    ]);
    expect(screen.getByText("The agent is reading the brief and inputs…")).toBeTruthy();
    expect(gets(fetchMock)).toBe(1);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(2_000);
    });
    expect(gets(fetchMock)).toBe(2);
    expect(screen.getByText("The agent is reading the brief and inputs…")).toBeTruthy();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(2_000);
    });
    expect(gets(fetchMock)).toBe(3);
    expect(screen.queryByText("The agent is reading the brief and inputs…")).toBeNull();
    expect(screen.getByText("Who reads the MOUs?")).toBeTruthy();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(20_000);
    });
    expect(gets(fetchMock)).toBe(3);
  });

  it("a failed job shows its detail and Retry starts a new request", async () => {
    const failed = clarifyState({ job: { status: "failed", detail: "model timed out" } });
    const fetchMock = server([failed], () => json(200, clarifyState({ job: { status: "running" } })));
    render(<ScopeTab {...props()} />);
    await flush();
    expect(screen.getByRole("alert").textContent).toContain("model timed out");
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    await flush();
    expect(posts(fetchMock).map((p) => p.url)).toEqual([`${BASE}/questions`]);
    expect(screen.getByText("The agent is reading the brief and inputs…")).toBeTruthy();
  });
});

describe("an open round", () => {
  it("renders each question with its category, why, chips and the progress line", async () => {
    server([openState()]);
    render(<ScopeTab {...props()} />);
    await flush();
    expect(document.querySelectorAll('[data-component="ClarifyQuestion"]')).toHaveLength(3);
    expect(card("q1").getByText("Audience")).toBeTruthy();
    expect(card("q1").getByText("Sets the tone and level of detail.")).toBeTruthy();
    expect(card("q2").getByText("Format")).toBeTruthy();
    expect(card("q3").queryByRole("group")).toBeNull();
    expect(screen.getByText("0 of 3 answered")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Save answers" })).toHaveProperty("disabled", true);
  });

  it("a chip fills the answer; tapping it again clears it; another replaces it", async () => {
    server([openState()]);
    render(<ScopeTab {...props()} />);
    await flush();
    fireEvent.click(card("q1").getByRole("button", { name: "Legal" }));
    expect(answerOf("q1")).toBe("Legal");
    expect(card("q1").getByRole("button", { name: "Legal" }).getAttribute("aria-pressed")).toBe("true");
    expect(screen.getByText("1 of 3 answered")).toBeTruthy();
    fireEvent.click(card("q1").getByRole("button", { name: "Board" }));
    expect(answerOf("q1")).toBe("Board");
    fireEvent.click(card("q1").getByRole("button", { name: "Board" }));
    expect(answerOf("q1")).toBe("");
  });

  it("multi-select chips combine", async () => {
    server([openState()]);
    render(<ScopeTab {...props()} />);
    await flush();
    fireEvent.click(card("q2").getByRole("button", { name: "PDF" }));
    fireEvent.click(card("q2").getByRole("button", { name: "Word" }));
    expect(answerOf("q2")).toBe("Word; PDF");
    expect(card("q2").getByRole("button", { name: "PDF" }).getAttribute("aria-pressed")).toBe("true");
    fireEvent.click(card("q2").getByRole("button", { name: "PDF" }));
    expect(answerOf("q2")).toBe("Word");
  });

  it("Skip marks the question skipped and Answer instead undoes it", async () => {
    server([openState()]);
    render(<ScopeTab {...props()} />);
    await flush();
    fireEvent.click(card("q3").getByRole("button", { name: "Skip" }));
    expect(card("q3").getByText(/Skipped/)).toBeTruthy();
    expect(card("q3").queryByRole("textbox")).toBeNull();
    expect(screen.getByText("0 of 3 answered · 1 skipped")).toBeTruthy();
    fireEvent.click(card("q3").getByRole("button", { name: "Answer instead" }));
    expect(card("q3").getByRole("textbox")).toBeTruthy();
  });

  it("Save posts every changed answer once, even on a double click, and shows the answer at once", async () => {
    const save = deferred<Response>();
    const fetchMock = server([openState()], () => save.promise);
    render(<ScopeTab {...props()} />);
    await flush();
    fireEvent.click(card("q1").getByRole("button", { name: "Legal" }));
    fireEvent.click(card("q2").getByRole("button", { name: "Word" }));
    fireEvent.click(card("q3").getByRole("button", { name: "Skip" }));
    const button = screen.getByRole("button", { name: "Save answers" });
    fireEvent.click(button);
    fireEvent.click(button);
    expect(screen.getByRole("button", { name: "Saving…" })).toHaveProperty("disabled", true);
    fireEvent.click(screen.getByRole("button", { name: "Saving…" }));
    await act(async () => save.resolve(json(200, answeredState())));

    expect(posts(fetchMock)).toEqual([
      {
        url: `${BASE}/answers`,
        body: { answers: [{ id: "q1", answer: "Legal" }, { id: "q2", answer: "Word" }, { id: "q3", skip: true }] },
        key: expect.any(String),
      },
    ]);
    expect(screen.getByText("Here’s what I understood")).toBeTruthy();
    expect(router.refresh).toHaveBeenCalledTimes(1);
  });

  it("Skip the rest skips every unanswered question", async () => {
    server([openState()]);
    render(<ScopeTab {...props()} />);
    await flush();
    fireEvent.change(card("q3").getByRole("textbox"), { target: { value: "End of May" } });
    fireEvent.click(screen.getByRole("button", { name: "Skip the rest" }));
    expect(screen.getByText("1 of 3 answered · 2 skipped")).toBeTruthy();
  });

  it("a failed save shows the error and Retry re-sends the same idempotency key", async () => {
    const fetchMock = server([openState()]);
    fetchMock.mockImplementation((_url: string, init?: RequestInit) => {
      if (!init?.method) return Promise.resolve(json(200, openState()));
      return Promise.resolve(posts(fetchMock).length === 1 ? json(500, { detail: "boom" }) : json(200, answeredState()));
    });
    render(<ScopeTab {...props()} />);
    await flush();
    fireEvent.change(card("q3").getByRole("textbox"), { target: { value: "End of May" } });
    fireEvent.click(screen.getByRole("button", { name: "Save answers" }));
    await flush();
    expect(screen.getByRole("alert")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Save answers" })).toHaveProperty("disabled", false);
    expect(router.refresh).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    await flush();
    const [first, second] = posts(fetchMock);
    expect(second.body).toEqual(first.body);
    expect(second.key).toBe(first.key);
    expect(screen.getByText("Here’s what I understood")).toBeTruthy();
  });
});

describe("the understanding", () => {
  function confirmServer(result: Partial<ClarifyConfirmResult> = {}) {
    return server([answeredState()], () =>
      json(200, { state: confirmedState(), plan_draft: { status: "drafting" }, ...result }),
    );
  }

  it("is pre-filled and editable; Confirm & draft the plan posts once and opens the plan", async () => {
    const fetchMock = confirmServer();
    const p = props();
    render(<ScopeTab {...p} />);
    await flush();
    const box = screen.getByLabelText("The agent’s understanding") as HTMLTextAreaElement;
    expect(box.value).toBe("Four MOUs, one per partner, for legal sign-off.");
    fireEvent.change(box, { target: { value: "Four MOUs for legal, in Word and PDF." } });
    const button = screen.getByRole("button", { name: "Confirm & draft the plan" });
    fireEvent.click(button);
    fireEvent.click(button);
    fireEvent.click(screen.getByRole("button", { name: "Confirm only" }));
    await flush();
    expect(posts(fetchMock)).toEqual([
      {
        url: `${BASE}/confirm`,
        body: { understanding: "Four MOUs for legal, in Word and PDF.", draft_plan: true },
        key: expect.any(String),
      },
    ]);
    expect(p.onNavigate).toHaveBeenCalledWith("plan");
  });

  it("a refused draft stays on Scope and says why", async () => {
    confirmServer({ plan_draft: { status: "refused", detail: "Add at least one output first." } });
    const p = props();
    render(<ScopeTab {...p} />);
    await flush();
    fireEvent.click(screen.getByRole("button", { name: "Confirm & draft the plan" }));
    await flush();
    expect(p.onNavigate).not.toHaveBeenCalled();
    expect(screen.getByRole("alert").textContent).toContain("Add at least one output first.");
    expect(screen.getByText("Agreed scope")).toBeTruthy();
  });

  it("Confirm only sends no understanding when unedited and shows the agreed scope", async () => {
    const fetchMock = confirmServer({ plan_draft: null });
    const p = props();
    render(<ScopeTab {...p} />);
    await flush();
    fireEvent.click(screen.getByRole("button", { name: "Confirm only" }));
    await flush();
    expect(posts(fetchMock)[0].body).toEqual({});
    expect(p.onNavigate).not.toHaveBeenCalled();
    expect(screen.getByText("Four MOUs for legal, in Word and PDF.")).toBeTruthy();
  });

  it("Ask follow-up questions posts the focus", async () => {
    const fetchMock = server([answeredState()], () => json(200, answeredState({ job: { status: "running" } })));
    render(<ScopeTab {...props()} />);
    await flush();
    fireEvent.change(screen.getByLabelText(/Anything the follow-up should dig into/), {
      target: { value: "signatories" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Ask follow-up questions" }));
    await flush();
    expect(posts(fetchMock)[0]).toMatchObject({ url: `${BASE}/questions`, body: { focus: "signatories" } });
    expect(screen.getByText("The agent is reading the brief and inputs…")).toBeTruthy();
  });

  it("unsaved changed answers hold back confirming", async () => {
    server([answeredState()]);
    render(<ScopeTab {...props()} />);
    await flush();
    fireEvent.click(card("q1").getByRole("button", { name: "Board" }));
    expect(screen.getByRole("button", { name: "Confirm & draft the plan" })).toHaveProperty("disabled", true);
    expect(screen.getByText("Save your changed answers first.")).toBeTruthy();
  });

  it("covers a done round with no questions", async () => {
    const done = clarifyState({
      status: "answered",
      round: 1,
      rounds: [answeredState().rounds[0]],
    });
    server([done]);
    render(<ScopeTab {...props()} />);
    await flush();
    expect(screen.getByText("Here’s what I understood")).toBeTruthy();
    expect(screen.queryByText("Review or change your answers")).toBeNull();
  });
});

describe("confirmed", () => {
  it("shows the agreed scope, the Q&A history by round and Ask more questions", async () => {
    const fetchMock = server([confirmedState()], () => json(200, confirmedState({ job: { status: "running" } })));
    render(<ScopeTab {...props()} />);
    await flush();
    expect(screen.getByText("Agreed scope")).toBeTruthy();
    expect(screen.getByText("Four MOUs for legal, in Word and PDF.")).toBeTruthy();
    const history = document.querySelector('[data-component="ClarifyHistory"]') as HTMLElement;
    expect(history.querySelectorAll("details")).toHaveLength(1);
    expect(within(history).getByText("Who reads the MOUs?")).toBeTruthy();
    expect(within(history).getByText("Word; PDF")).toBeTruthy();
    expect(within(history).getByText("Skipped")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Ask more questions" }));
    await flush();
    expect(posts(fetchMock)[0]).toMatchObject({ url: `${BASE}/questions`, body: {} });
  });
});

describe("read-only", () => {
  it("a viewer sees questions and answers but no inputs or buttons", async () => {
    server([openState()]);
    render(<ScopeTab {...props({ canLead: false })} />);
    await flush();
    expect(screen.getByText("Who reads the MOUs?")).toBeTruthy();
    expect(screen.queryAllByRole("textbox")).toHaveLength(0);
    expect(screen.queryByRole("button", { name: "Save answers" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Legal" })).toBeNull();
    expect(screen.getAllByText("Not answered yet")).toHaveLength(3);
  });

  it("a viewer of a new project gets no hero", async () => {
    server([clarifyState()]);
    render(<ScopeTab {...props({ canLead: false })} />);
    await flush();
    expect(screen.getByText("The agent hasn't asked about scope yet.")).toBeTruthy();
    expect(screen.queryByRole("button")).toBeNull();
  });

  it("an archived project shows the understanding read-only", async () => {
    server([answeredState()]);
    render(<ScopeTab {...props({ project: project({ archived: true }) })} />);
    await flush();
    expect(screen.getByText("Four MOUs, one per partner, for legal sign-off.")).toBeTruthy();
    expect(screen.queryByRole("button", { name: /Confirm/ })).toBeNull();
    expect(screen.queryAllByRole("textbox")).toHaveLength(0);
  });

  it("an archived confirmed project cannot ask more", async () => {
    server([confirmedState()]);
    render(<ScopeTab {...props({ project: project({ archived: true }) })} />);
    await flush();
    expect(screen.getByText("Agreed scope")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Ask more questions" })).toBeNull();
  });
});
