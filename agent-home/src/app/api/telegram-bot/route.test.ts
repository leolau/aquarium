/**
 * BFF tests for the caller's own Telegram bot (Get ready item 6): every
 * route needs a principal, forwards under the bridged client, passes Hermes
 * errors through, and only known actions reach Hermes.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

import { DELETE as actionDELETE, POST as actionPOST } from "@/app/api/telegram-bot/[...action]/route";
import { DELETE, GET, PUT } from "@/app/api/telegram-bot/route";
import { HermesApiError } from "@/lib/api/client";
import type { Principal } from "@/types";

const getPrincipal = vi.fn<() => Promise<Principal | null>>();
const telegramBot = vi.fn();
const saveTelegramBot = vi.fn();
const removeTelegramBot = vi.fn();
const telegramBotAction = vi.fn();

vi.mock("@/lib/auth/principal", () => ({
  getPrincipal: () => getPrincipal(),
  apiClientForRequest: async () => ({ telegramBot, saveTelegramBot, removeTelegramBot, telegramBotAction }),
}));

const ALICE: Principal = { user_id: "alice", display: "Alice", role: "member", channels: [], is_owner: false };
const VIEW = { configured: true, linked: false, bot_username: "alice_bot" };

function ctx(...action: string[]) {
  return { params: Promise.resolve({ action }) };
}

function put(body: unknown): Request {
  return new Request("http://localhost/api/telegram-bot", {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  getPrincipal.mockResolvedValue(ALICE);
});

describe("/api/telegram-bot", () => {
  it("401s when unauthenticated and never calls Hermes", async () => {
    getPrincipal.mockResolvedValue(null);
    expect((await GET()).status).toBe(401);
    expect((await PUT(put({ token: "1:x" }))).status).toBe(401);
    expect((await actionPOST(new Request("http://x"), ctx("test"))).status).toBe(401);
    expect(telegramBot).not.toHaveBeenCalled();
    expect(saveTelegramBot).not.toHaveBeenCalled();
    expect(telegramBotAction).not.toHaveBeenCalled();
  });

  it("forwards reads, saves and removes", async () => {
    telegramBot.mockResolvedValue(VIEW);
    saveTelegramBot.mockResolvedValue(VIEW);
    removeTelegramBot.mockResolvedValue({ configured: false, linked: false });
    expect(await (await GET()).json()).toEqual(VIEW);
    expect((await PUT(put({ token: " 123:abc " }))).status).toBe(200);
    expect(saveTelegramBot).toHaveBeenCalledWith("123:abc");
    expect(await (await DELETE()).json()).toEqual({ configured: false, linked: false });
  });

  it("rejects a PUT without a token before Hermes", async () => {
    const res = await PUT(put({}));
    expect(res.status).toBe(400);
    expect(saveTelegramBot).not.toHaveBeenCalled();
  });

  it("passes Hermes errors through", async () => {
    saveTelegramBot.mockRejectedValue(new HermesApiError(409, "bot_in_use"));
    const res = await PUT(put({ token: "123:abc" }));
    expect(res.status).toBe(409);
    expect((await res.json()).detail).toContain("bot_in_use");
  });

  it("forwards only known actions", async () => {
    telegramBotAction.mockResolvedValue(VIEW);
    expect((await actionPOST(new Request("http://x"), ctx("link", "start"))).status).toBe(200);
    expect(telegramBotAction).toHaveBeenCalledWith("link/start");
    expect((await actionDELETE(new Request("http://x"), ctx("link"))).status).toBe(200);
    expect(telegramBotAction).toHaveBeenLastCalledWith("link", "DELETE");
    expect((await actionPOST(new Request("http://x"), ctx("link"))).status).toBe(404);
    expect((await actionPOST(new Request("http://x"), ctx("..", "credentials"))).status).toBe(404);
    expect((await actionDELETE(new Request("http://x"), ctx("test"))).status).toBe(404);
    expect(telegramBotAction).toHaveBeenCalledTimes(2);
  });
});
