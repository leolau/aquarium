import { describe, expect, it, vi } from "vitest";

import type { HermesApiClient } from "@/lib/api/client";
import { loadWhoseData, NO_WHOSE_DATA, ownerLabel, type ViewablePeople } from "@/lib/whose-data";

const MIA: ViewablePeople = {
  me: "mia",
  role_reads: true,
  people: [
    { user_id: "mia", display: "Mia", role: "admin" },
    { user_id: "sam", display: "Sam", role: "member" },
  ],
};

function client(request: () => Promise<unknown>): HermesApiClient {
  return { request: vi.fn(request) } as unknown as HermesApiClient;
}

describe("loadWhoseData", () => {
  it("opens on just you when you may read other people's data", async () => {
    const c = client(async () => MIA);
    expect(await loadWhoseData(c, "mia")).toEqual({ roster: MIA, owners: ["mia"] });
    expect(c.request).toHaveBeenCalledWith("/api/access/viewable-people");
  });

  it("leaves the view as it is when you may only read your own", async () => {
    const solo = { me: "sam", role_reads: false, people: [MIA.people[1]] };
    expect(await loadWhoseData(client(async () => solo), "sam")).toEqual(NO_WHOSE_DATA);
  });

  it("still opens on just you when the roster cannot be loaded", async () => {
    const down = client(async () => {
      throw new Error("502");
    });
    expect(await loadWhoseData(down, "leo")).toEqual({ roster: null, owners: ["leo"] });
  });
});

describe("ownerLabel", () => {
  it("names whose a row is only once the view reaches past yourself", () => {
    expect(ownerLabel(MIA, ["mia"], "mia")).toBeNull();
    expect(ownerLabel(MIA, ["mia", "sam"], "sam")).toBe("Sam");
    expect(ownerLabel(MIA, ["mia", "sam"], "mia")).toBe("Me");
    expect(ownerLabel(MIA, ["sam"], "someone-else")).toBe("someone-else");
    expect(ownerLabel(null, ["sam"], "sam")).toBeNull();
  });
});
