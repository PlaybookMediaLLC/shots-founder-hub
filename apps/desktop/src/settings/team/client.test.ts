import { describe, expect, it, vi } from "vitest";

import {
  getWorkspaceAccess,
  getWorkspacePolicy,
  intersectAllowedShareScopes,
  listWorkspaceMembers,
  requireTeamContext,
  TeamError,
  type TeamContext,
} from "./client";

const WORKSPACE_ID = "11111111-1111-4111-8111-111111111111";
const USER_ID = "22222222-2222-4222-8222-222222222222";

function context(data: unknown, error: { message: string } | null = null) {
  const rpc = vi.fn(() => ({
    setHeader: () => Promise.resolve({ data, error }),
  }));
  return {
    context: {
      cloudClient: { rpc },
      session: { access_token: "token", user: { id: USER_ID } },
    } as unknown as TeamContext,
    rpc,
  };
}

describe("requireTeamContext", () => {
  it("refuses anonymous and signed-out callers", () => {
    expect(() => requireTeamContext({})).toThrow(TeamError);
    expect(() =>
      requireTeamContext({
        cloudClient: {} as never,
        session: { user: { is_anonymous: true } } as never,
      }),
    ).toThrow(TeamError);
  });
});

describe("workspace reads", () => {
  it("parses workspace-scoped capabilities and ignores future additions", async () => {
    const { context: ctx } = context([
      {
        workspace_role: "admin",
        workspace_tier: "enterprise",
        capabilities: [
          "team.manage_members",
          "enterprise.capture",
          "future.capability",
        ],
        seat_limit: 12,
        used_seats: 4,
      },
    ]);

    await expect(getWorkspaceAccess(ctx, WORKSPACE_ID)).resolves.toEqual({
      role: "admin",
      tier: "enterprise",
      capabilities: ["team.manage_members", "enterprise.capture"],
      seatLimit: 12,
      usedSeats: 4,
    });
  });

  it("keeps only active members and normalizes their role", async () => {
    const { context: ctx } = context([
      {
        user_id: USER_ID,
        user_email: "a@example.com",
        user_name: "Alice",
        user_avatar_url: "https://example.com/avatar.png",
        role: "owner",
        deleted_at: null,
      },
      {
        user_id: WORKSPACE_ID,
        user_email: "gone@example.com",
        role: "member",
        deleted_at: "2026-08-11T00:00:00Z",
      },
    ]);

    await expect(listWorkspaceMembers(ctx, WORKSPACE_ID)).resolves.toEqual([
      {
        userId: USER_ID,
        email: "a@example.com",
        name: "Alice",
        avatarUrl: "https://example.com/avatar.png",
        role: "owner",
      },
    ]);
  });

  it("intersects org share policies so clients hide disallowed scopes", async () => {
    const { context: ctx } = context([
      {
        allowed_share_scopes: ["restricted", "workspace"],
        default_share_scope: "restricted",
        retention_days: 30,
        model_training_opt_out: true,
        consent_notification_enabled: true,
        require_sso: false,
      },
    ]);

    const policy = await getWorkspacePolicy(ctx, WORKSPACE_ID);
    expect(
      intersectAllowedShareScopes([
        policy,
        {
          allowedShareScopes: ["restricted", "workspace", "link", "public"],
        },
      ]),
    ).toEqual(["restricted", "workspace"]);
  });
});

describe("failure handling", () => {
  it("surfaces the server's reason so managers see why an action failed", async () => {
    const { context: ctx } = context(null, {
      message: "workspace seat limit reached",
    });

    await expect(getWorkspaceAccess(ctx, WORKSPACE_ID)).rejects.toThrow(
      "workspace seat limit reached",
    );
  });

  it("rejects malformed identifiers before reaching the network", async () => {
    const { context: ctx, rpc } = context([]);

    await expect(getWorkspaceAccess(ctx, "not-a-uuid")).rejects.toThrow(
      TeamError,
    );
    expect(rpc).not.toHaveBeenCalled();
  });

  it("treats a missing row as a failure rather than returning undefined", async () => {
    const { context: ctx } = context([]);

    await expect(getWorkspaceAccess(ctx, WORKSPACE_ID)).rejects.toThrow(
      TeamError,
    );
  });
});
