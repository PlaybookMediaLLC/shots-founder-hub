import type { Session, CloudClient } from "@anlg/cloud-client";

export type TeamContext = {
  cloudClient: CloudClient;
  session: Session;
};

export type WorkspaceRole = "owner" | "admin" | "member";

export type WorkspaceMember = {
  userId: string;
  email: string;
  name: string | null;
  avatarUrl: string | null;
  role: WorkspaceRole;
};

const WORKSPACE_CAPABILITIES = [
  "team.shared_notes",
  "team.shared_resources",
  "team.manage_workspace",
  "team.manage_members",
  "team.manage_policies",
  "team.view_usage",
  "team.custom_subdomain",
  "enterprise.sso",
  "enterprise.scim",
  "enterprise.retention",
  "enterprise.audit_logs",
  "enterprise.capture",
] as const;

export type WorkspaceCapability = (typeof WORKSPACE_CAPABILITIES)[number];
type WorkspaceTier = "free" | "team" | "enterprise";

export type WorkspaceAccess = {
  role: WorkspaceRole;
  tier: WorkspaceTier;
  capabilities: WorkspaceCapability[];
  seatLimit: number | null;
  usedSeats: number;
};

export class TeamError extends Error {
  constructor(message = "Workspace request failed") {
    super(message);
    this.name = "TeamError";
  }
}

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function requireTeamContext(auth: {
  cloudClient?: CloudClient | null;
  session?: Session | null;
}): TeamContext {
  if (!auth.cloudClient || !auth.session || auth.session.user.is_anonymous) {
    throw new TeamError();
  }
  return { cloudClient: auth.cloudClient, session: auth.session };
}

async function callRpc(
  context: TeamContext,
  functionName: string,
  args: Record<string, unknown>,
): Promise<unknown> {
  const response = await context.cloudClient
    .rpc(functionName, args)
    .setHeader("Authorization", `Bearer ${context.session.access_token}`);
  if (response.error !== null) {
    // Server messages carry the reason a manager needs (seat limit, permission)
    // and are written for humans, so they are surfaced rather than swallowed.
    throw new TeamError(response.error.message);
  }
  return response.data;
}

function rows(value: unknown): Record<string, unknown>[] {
  if (!Array.isArray(value)) throw new TeamError();
  return value as Record<string, unknown>[];
}

function text(value: unknown): string {
  if (typeof value !== "string" || value === "") throw new TeamError();
  return value;
}

function role(value: unknown): WorkspaceRole {
  if (value !== "owner" && value !== "admin" && value !== "member") {
    throw new TeamError();
  }
  return value;
}

export async function listWorkspaceMembers(
  context: TeamContext,
  workspaceId: string,
): Promise<WorkspaceMember[]> {
  assertWorkspaceId(workspaceId);
  return rows(
    await callRpc(context, "list_workspace_members_with_profiles", {
      p_workspace_id: workspaceId,
    }),
  )
    .filter((row) => row.deleted_at === null)
    .map((row) => ({
      userId: text(row.user_id),
      email: text(row.user_email),
      name: typeof row.user_name === "string" ? row.user_name : null,
      avatarUrl:
        typeof row.user_avatar_url === "string" ? row.user_avatar_url : null,
      role: role(row.role),
    }));
}

export async function getWorkspaceAccess(
  context: TeamContext,
  workspaceId: string,
): Promise<WorkspaceAccess> {
  assertWorkspaceId(workspaceId);
  const row = rows(
    await callRpc(context, "get_workspace_access", {
      p_workspace_id: workspaceId,
    }),
  )[0];
  if (!row) throw new TeamError();
  const capabilities = Array.isArray(row.capabilities)
    ? row.capabilities.filter(isWorkspaceCapability)
    : [];
  return {
    role: role(row.workspace_role),
    tier: workspaceTier(row.workspace_tier),
    capabilities,
    seatLimit: typeof row.seat_limit === "number" ? row.seat_limit : null,
    usedSeats: typeof row.used_seats === "number" ? row.used_seats : 0,
  };
}

export type WorkspacePolicy = {
  allowedShareScopes: Array<"restricted" | "workspace" | "link" | "public">;
  defaultShareScope: "restricted" | "workspace" | "link" | "public";
  retentionDays: number | null;
  modelTrainingOptOut: boolean;
  consentNotificationEnabled: boolean;
  requireSso: boolean;
};

function numberOrNull(value: unknown): number | null {
  return typeof value === "number" ? value : null;
}

function shareScope(
  value: unknown,
): "restricted" | "workspace" | "link" | "public" {
  if (
    value !== "restricted" &&
    value !== "workspace" &&
    value !== "link" &&
    value !== "public"
  ) {
    throw new TeamError();
  }
  return value;
}

export async function getWorkspacePolicy(
  context: TeamContext,
  workspaceId: string,
): Promise<WorkspacePolicy> {
  assertWorkspaceId(workspaceId);
  const row = rows(
    await callRpc(context, "get_workspace_policy", {
      p_workspace_id: workspaceId,
    }),
  )[0];
  if (!row) throw new TeamError();
  const scopes = Array.isArray(row.allowed_share_scopes)
    ? row.allowed_share_scopes.map(shareScope)
    : (["restricted"] as WorkspacePolicy["allowedShareScopes"]);
  return {
    allowedShareScopes: scopes,
    defaultShareScope: shareScope(row.default_share_scope),
    retentionDays: numberOrNull(row.retention_days),
    modelTrainingOptOut: row.model_training_opt_out !== false,
    consentNotificationEnabled: row.consent_notification_enabled !== false,
    requireSso: row.require_sso === true,
  };
}

export function intersectAllowedShareScopes(
  policies: Array<Pick<WorkspacePolicy, "allowedShareScopes">>,
): WorkspacePolicy["allowedShareScopes"] {
  const scopes: WorkspacePolicy["allowedShareScopes"] = [
    "restricted",
    "workspace",
    "link",
    "public",
  ];
  if (policies.length === 0) return scopes;
  return scopes.filter((scope) =>
    policies.every((policy) => policy.allowedShareScopes.includes(scope)),
  );
}

export async function listMyWorkspaces(context: TeamContext) {
  // RLS limits the embedded memberships to this account's own row, so the join
  // yields the caller's role without needing manager-only RPCs.
  const response = await context.cloudClient.workspaces();
  if (response.error !== null) throw new TeamError(response.error.message);
  return (response.data ?? []).map((row) => {
    const memberships = Array.isArray(row.workspace_memberships)
      ? row.workspace_memberships
      : [];
    return {
      workspaceId: text(row.id),
      name: text(row.name),
      ownerUserId: text(row.owner_user_id),
      logoDataUrl: typeof row.logo_data === "string" ? row.logo_data : null,
      role: role(memberships[0]?.role ?? "member"),
    };
  });
}

function isWorkspaceCapability(value: unknown): value is WorkspaceCapability {
  return WORKSPACE_CAPABILITIES.some((capability) => capability === value);
}

function workspaceTier(value: unknown): WorkspaceTier {
  if (value !== "free" && value !== "team" && value !== "enterprise") {
    throw new TeamError();
  }
  return value;
}

function assertWorkspaceId(value: string) {
  if (!UUID_PATTERN.test(value)) throw new TeamError();
}
