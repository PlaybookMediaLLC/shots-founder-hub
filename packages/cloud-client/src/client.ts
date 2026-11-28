import type { SessionClaims } from "./jwt";

export type UserIdentity = {
  id: string;
  identity_id?: string;
  user_id?: string;
  provider: string;
  identity_data?: Record<string, unknown>;
  created_at?: string;
  updated_at?: string;
  last_sign_in_at?: string;
};
export type User = {
  id: string;
  email?: string;
  aud: string;
  role?: string;
  created_at: string;
  app_metadata: Record<string, any>;
  user_metadata: Record<string, any>;
  identities?: UserIdentity[];
  is_anonymous?: boolean;
  email_confirmed_at?: string;
  confirmed_at?: string;
  updated_at?: string;
  last_sign_in_at?: string;
};
export type Session = {
  access_token: string;
  refresh_token: string;
  token_type: string;
  expires_in: number;
  expires_at?: number;
  user: User;
};
export type AuthChangeEvent =
  | "INITIAL_SESSION"
  | "SIGNED_IN"
  | "SIGNED_OUT"
  | "TOKEN_REFRESHED"
  | "USER_UPDATED"
  | "PASSWORD_RECOVERY";
export type SupportedStorage = {
  getItem(key: string): string | null | Promise<string | null>;
  setItem(key: string, value: string): void | Promise<void>;
  removeItem(key: string): void | Promise<void>;
};

export class AuthError extends Error {
  status: number;
  code: string;
  constructor(message: string, status = 0, code = "request_failed") {
    super(message);
    this.status = status;
    this.code = code;
    this.name = "AuthError";
  }
}
export class AuthApiError extends AuthError {}
export class AuthRetryableFetchError extends AuthError {
  constructor(message: string, status = 0) {
    super(message, status, "temporarily_unavailable");
    this.name = "AuthRetryableFetchError";
  }
}
export class AuthSessionMissingError extends AuthError {
  constructor(message = "Sign in to continue.") {
    super(message, 401, "session_not_found");
    this.name = "AuthSessionMissingError";
  }
}

type Result<T> =
  | { data: T; error: null; status: number }
  | { data: null; error: AuthError; status: number };
const locks = new Map<string, Promise<unknown>>();
export async function processLock<T>(
  name: string,
  _timeout: number,
  operation: () => Promise<T>,
): Promise<T> {
  const previous = locks.get(name) ?? Promise.resolve();
  const next = previous.catch(() => {}).then(operation);
  locks.set(name, next);
  try {
    return await next;
  } finally {
    if (locks.get(name) === next) locks.delete(name);
  }
}

function isUser(value: unknown): value is User {
  if (!value || typeof value !== "object") return false;
  const user = value as User;
  const record = (value: unknown) =>
    value !== null && typeof value === "object" && !Array.isArray(value);
  return (
    typeof user.id === "string" &&
    user.id.length > 0 &&
    typeof user.aud === "string" &&
    typeof user.created_at === "string" &&
    record(user.app_metadata) &&
    record(user.user_metadata) &&
    (user.email === undefined || typeof user.email === "string") &&
    (user.identities === undefined ||
      (Array.isArray(user.identities) &&
        user.identities.every(
          (identity) =>
            identity &&
            typeof identity.id === "string" &&
            typeof identity.provider === "string",
        )))
  );
}

function sessionFrom(value: unknown): Session | null {
  if (!value || typeof value !== "object") return null;
  const session = value as Session;
  return typeof session.access_token === "string" &&
    !!session.access_token &&
    typeof session.refresh_token === "string" &&
    !!session.refresh_token &&
    isUser(session.user) &&
    session.token_type === "bearer" &&
    Number.isFinite(session.expires_in) &&
    session.expires_in > 0 &&
    (session.expires_at === undefined ||
      (Number.isFinite(session.expires_at) && session.expires_at > 0))
    ? session
    : null;
}

class Request<T = any> implements PromiseLike<Result<T>> {
  private headers = new Headers();
  private signal?: AbortSignal;
  private execute: (
    headers: Headers,
    signal?: AbortSignal,
  ) => Promise<Result<T>>;
  constructor(
    execute: (headers: Headers, signal?: AbortSignal) => Promise<Result<T>>,
  ) {
    this.execute = execute;
  }
  setHeader(name: string, value: string) {
    this.headers.set(name, value);
    return this;
  }
  abortSignal(signal: AbortSignal) {
    this.signal = signal;
    return this;
  }
  then<TResult1 = Result<T>, TResult2 = never>(
    fulfilled?: ((value: Result<T>) => TResult1 | PromiseLike<TResult1>) | null,
    rejected?: ((reason: any) => TResult2 | PromiseLike<TResult2>) | null,
  ): PromiseLike<TResult1 | TResult2> {
    return this.execute(this.headers, this.signal).then(fulfilled, rejected);
  }
}

export class CloudClient {
  readonly cloudUrl: string;
  private storage?: SupportedStorage;
  private key: string;
  private memory: Session | null = null;
  private listeners = new Set<
    (event: AuthChangeEvent, session: Session | null) => void | Promise<void>
  >();
  private timer?: ReturnType<typeof setInterval>;
  private revision = 0;
  private fetcher: typeof fetch;
  readonly auth;

  constructor(
    cloudUrl: string,
    options: {
      global?: { fetch?: typeof fetch };
      auth?: {
        storage?: SupportedStorage;
        storageKey?: string;
        autoRefreshToken?: boolean;
        persistSession?: boolean;
        detectSessionInUrl?: boolean;
        lock?: typeof processLock;
      };
    } = {},
  ) {
    const url = new URL(cloudUrl);
    if (
      url.username ||
      url.password ||
      url.search ||
      url.hash ||
      (url.protocol !== "https:" &&
        !(
          url.protocol === "http:" &&
          ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)
        ))
    )
      throw new Error("Invalid cloud API URL");
    this.cloudUrl = cloudUrl.replace(/\/$/, "");
    this.key = options.auth?.storageKey ?? `founder-hub:${url.origin}:session`;
    this.storage =
      options.auth?.persistSession === false
        ? undefined
        : (options.auth?.storage ??
          (typeof localStorage !== "undefined" ? localStorage : undefined));
    this.fetcher = options.global?.fetch ?? globalThis.fetch.bind(globalThis);
    const lock = options.auth?.lock ?? processLock;
    const locked = <T>(operation: () => Promise<T>) => {
      const run = () => lock(this.key, 10000, operation);
      return typeof navigator !== "undefined" && navigator.locks
        ? navigator.locks.request(this.key, run)
        : run();
    };
    this.auth = {
      getSession: async (): Promise<{
        data: { session: Session | null };
        error: AuthError | null;
      }> => {
        const session = await this.read();
        if (session?.expires_at && session.expires_at * 1000 <= Date.now())
          return this.auth.refreshSession();
        return { data: { session }, error: null };
      },
      getUser: async (token?: string) => {
        const revision = this.revision;
        const current = await this.read();
        const result = await this.request<User>(
          "/auth/v1/user",
          "GET",
          undefined,
          new Headers(token ? { Authorization: `Bearer ${token}` } : undefined),
        );
        if (result.error) return { data: { user: null }, error: result.error };
        if (!isUser(result.data))
          return {
            data: { user: null },
            error: new AuthError("Invalid user response"),
          };
        const latest = await this.read();
        if (
          current &&
          revision === this.revision &&
          latest?.access_token === current.access_token &&
          result.data.id === current.user.id
        )
          await this.save({ ...current, user: result.data });
        return { data: { user: result.data }, error: null };
      },
      setSession: (tokens: { access_token: string; refresh_token: string }) =>
        locked(async () => {
          const revision = this.revision;
          if (!tokens.access_token || !tokens.refresh_token)
            return {
              data: { session: null, user: null },
              error: new AuthSessionMissingError(),
            };
          const result = await this.request<User>(
            "/auth/v1/user",
            "GET",
            undefined,
            new Headers({ Authorization: `Bearer ${tokens.access_token}` }),
          );
          if (result.error)
            return { data: { session: null, user: null }, error: result.error };
          if (!isUser(result.data))
            return {
              data: { session: null, user: null },
              error: new AuthError("Invalid user response"),
            };
          if (revision !== this.revision)
            return {
              data: { session: null, user: null },
              error: new AuthSessionMissingError(),
            };
          // The live authority validates opaque access tokens; refresh establishes the exact expiry.
          const session: Session = {
            ...tokens,
            user: result.data,
            token_type: "bearer",
            expires_in: 60,
            expires_at: Math.floor(Date.now() / 1000) + 60,
          };
          await this.save(session);
          this.emit("SIGNED_IN", session);
          return { data: { session, user: session.user }, error: null };
        }),
      refreshSession: (tokens?: { refresh_token: string }) =>
        locked(async () => {
          const current = await this.read();
          const refreshToken = tokens?.refresh_token ?? current?.refresh_token;
          if (!refreshToken)
            return {
              data: { session: null, user: null },
              error: new AuthSessionMissingError(),
            };
          const revision = this.revision;
          const result = await this.request<Session>(
            "/auth/v1/token?grant_type=refresh_token",
            "POST",
            { refresh_token: refreshToken },
            new Headers(),
            undefined,
            false,
          );
          if (result.error)
            return { data: { session: null, user: null }, error: result.error };
          const session = sessionFrom(result.data);
          if (!session)
            return {
              data: { session: null, user: null },
              error: new AuthError("Invalid session response"),
            };
          const latest = await this.read();
          if (
            revision !== this.revision ||
            (current && latest?.refresh_token !== current.refresh_token)
          )
            return {
              data: { session: null, user: null },
              error: new AuthSessionMissingError(),
            };
          await this.save(session);
          this.emit("TOKEN_REFRESHED", session);
          return { data: { session, user: session.user }, error: null };
        }),
      signOut: async (options?: { scope?: "local" | "global" | "others" }) => {
        if (options?.scope && options.scope !== "local")
          return {
            error: new AuthError("Manage all sessions in Shots settings", 400),
          };
        this.revision += 1;
        return locked(async () => {
          const result = await this.request<void>(
            "/auth/v1/logout?scope=local",
            "POST",
          );
          if (result.error && result.status !== 401)
            return { error: result.error };
          await this.save(null);
          this.emit("SIGNED_OUT", null);
          return { error: null };
        });
      },
      onAuthStateChange: (
        callback: (
          event: AuthChangeEvent,
          session: Session | null,
        ) => void | Promise<void>,
      ) => {
        this.listeners.add(callback);
        void this.read().then((session) => {
          if (this.listeners.has(callback))
            void Promise.resolve()
              .then(() => callback("INITIAL_SESSION", session))
              .catch(() => {});
        });
        return {
          data: {
            subscription: {
              unsubscribe: () => {
                this.listeners.delete(callback);
              },
            },
          },
        };
      },
      startAutoRefresh: async () => {
        if (this.timer) return;
        const tick = async () => {
          const session = await this.read();
          if (
            session &&
            (!session.expires_at ||
              session.expires_at * 1000 < Date.now() + 60000)
          )
            await this.auth.refreshSession();
        };
        this.timer = setInterval(() => {
          void tick().catch(() => {});
        }, 30000);
        await tick();
      },
      stopAutoRefresh: async () => {
        if (this.timer) clearInterval(this.timer);
        this.timer = undefined;
      },
    };
    if (options.auth?.autoRefreshToken)
      void this.auth.startAutoRefresh().catch(() => {});
  }

  private async read(): Promise<Session | null> {
    if (!this.storage) return this.memory;
    try {
      const value = await this.storage.getItem(this.key);
      return value ? sessionFrom(JSON.parse(value)) : null;
    } catch {
      return null;
    }
  }
  private async save(session: Session | null) {
    this.revision += 1;
    this.memory = session;
    if (this.storage) {
      if (session)
        await this.storage.setItem(this.key, JSON.stringify(session));
      else await this.storage.removeItem(this.key);
    }
  }
  private emit(event: AuthChangeEvent, session: Session | null) {
    for (const callback of this.listeners)
      queueMicrotask(() => {
        void Promise.resolve()
          .then(() => callback(event, session))
          .catch(() => {});
      });
  }
  async request<T = any>(
    path: string,
    method = "GET",
    body?: unknown,
    headers = new Headers(),
    signal?: AbortSignal,
    authenticated = true,
  ): Promise<Result<T>> {
    if (authenticated && !headers.has("authorization")) {
      const session = await this.read();
      if (session)
        headers.set("authorization", `Bearer ${session.access_token}`);
    }
    if (body !== undefined) headers.set("content-type", "application/json");
    const controller = new AbortController();
    const abort = () => controller.abort();
    signal?.addEventListener("abort", abort, { once: true });
    if (signal?.aborted) controller.abort();
    const timeout = setTimeout(abort, 30000);
    try {
      const response = await this.fetcher(`${this.cloudUrl}${path}`, {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: controller.signal,
        redirect: "error",
      });
      const data: any =
        response.status === 204
          ? null
          : await response.json().catch(() => null);
      if (!response.ok) {
        const error =
          response.status >= 500
            ? new AuthRetryableFetchError(
                "Cloud service temporarily unavailable",
                response.status,
              )
            : response.status === 401
              ? new AuthSessionMissingError()
              : new AuthError(
                  typeof data?.message === "string"
                    ? data.message
                    : (data?.code ?? "Cloud request failed"),
                  response.status,
                  data?.code,
                );
        return { data: null, error, status: response.status };
      }
      if (response.status !== 204 && data === null)
        throw new Error("Invalid cloud response");
      return { data, error: null, status: response.status };
    } catch (error) {
      if (signal?.aborted) throw error;
      return {
        data: null,
        error: new AuthRetryableFetchError("Could not reach the cloud service"),
        status: 0,
      };
    } finally {
      clearTimeout(timeout);
      signal?.removeEventListener("abort", abort);
    }
  }
  rpc<T = any>(name: string, body: Record<string, unknown> = {}) {
    return new Request<T>((headers, signal) =>
      this.request(
        `/data/rpc/${encodeURIComponent(name)}`,
        "POST",
        body,
        headers,
        signal,
      ),
    );
  }
  workspaces() {
    return new Request<
      Array<{
        id: string;
        name: string;
        kind: string;
        owner_user_id: string;
        share_slug: string | null;
        logo_data: string | null;
        workspace_memberships: Array<{ role: string }>;
      }>
    >((headers, signal) =>
      this.request("/data/workspaces", "GET", undefined, headers, signal),
    );
  }
  devices() {
    return this.request<
      Array<{
        id: string;
        device_name: string;
        created_at: string;
        last_seen_at: string;
      }>
    >("/data/devices");
  }
  deleteDevice(id: string) {
    return this.request<void>(
      `/data/devices/${encodeURIComponent(id)}`,
      "DELETE",
    );
  }
  profile() {
    return this.request<{ stripe_customer_id: string | null }>("/data/profile");
  }
  claims(token?: string) {
    return this.request<SessionClaims>(
      "/auth/v1/claims",
      "GET",
      undefined,
      new Headers(token ? { authorization: `Bearer ${token}` } : undefined),
    );
  }
}

export function createClient(
  url: string,
  options?: ConstructorParameters<typeof CloudClient>[1],
) {
  return new CloudClient(url, options);
}
