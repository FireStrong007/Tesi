import { describe, expect, it } from "vitest";
import { DEFAULT_GOALS } from "@bridge/core/goals";
import { participantClients, tempDir, testServer } from "./helpers";

const dir = tempDir();

describe("a participant's goals, kept by the server", () => {
  it("default goals, saved per account, checked, and kept after logout", async () => {
    const s = await testServer({ dir });
    const { participants } = await participantClients(s, ["SYN-G01", "SYN-G02"]);
    const a = participants.get("SYN-G01")!;
    const b = participants.get("SYN-G02")!;
    expect((await a.client.get("/api/me/settings")).body).toEqual({ goals: DEFAULT_GOALS });

    const saved = await a.client.post<{ goals: typeof DEFAULT_GOALS }>("/api/me/settings", { goals: { step_goal: 10_000, sleep_goal_min: 450 } });
    expect(saved.status).toBe(200);
    expect(saved.body.goals).toEqual({ ...DEFAULT_GOALS, step_goal: 10_000, sleep_goal_min: 450 });
    // only a partial change: the other saved goals stay
    await a.client.post("/api/me/settings", { goals: { calories_goal: 500 } });
    expect((await a.client.get<{ goals: typeof DEFAULT_GOALS }>("/api/me/settings")).body.goals).toEqual({ ...DEFAULT_GOALS, step_goal: 10_000, sleep_goal_min: 450, calories_goal: 500 });
    // another participant keeps theirs
    expect((await b.client.get("/api/me/settings")).body).toEqual({ goals: DEFAULT_GOALS });

    for (const bad of [{ step_goal: 10 }, { step_goal: 8000.5 }, { step_goal: "8000" }, { nickname: 3 }, null]) {
      const r = await a.client.post("/api/me/settings", { goals: bad });
      expect(r.status).toBe(400);
    }
    // after logout and a new login (the browser's copy is gone, the goals are not)
    await a.client.post("/api/auth/logout");
    const again = s.client();
    await again.login("syn-g01", a.password);
    expect((await again.get<{ goals: typeof DEFAULT_GOALS }>("/api/me/settings")).body.goals.step_goal).toBe(10_000);
  });
});
