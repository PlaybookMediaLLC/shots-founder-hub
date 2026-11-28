import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  shots: undefined as string | undefined,
  signedIn: true,
  getUser: vi.fn(),
  save: vi.fn(),
  mirror: vi.fn(),
}));
vi.mock("~/env", () => ({
  env: {
    get VITE_SHOTS_URL() {
      return mocks.shots;
    },
  },
}));
vi.mock("~/auth", () => ({
  useAuth: () => ({
    session: mocks.signedIn ? { user: { id: "account-1" } } : null,
    cloudClient: { auth: { getUser: mocks.getUser } },
  }),
}));
vi.mock("./shared", () => ({ ContactFacehash: () => <span>No photo</span> }));
vi.mock("./contact-avatar", () => ({
  ContactImage: ({ src }: { src: string }) => <img src={src} alt="Profile" />,
  AvatarUploadButton: ({
    children,
    onUpload,
  }: {
    children: React.ReactNode;
    onUpload: (value: string) => void;
  }) => (
    <button
      type="button"
      onClick={() => onUpload("data:image/jpeg;base64,bmV3")}
    >
      {children}Change photo
    </button>
  ),
}));
import { ProfilePhoto } from "./profile-photo";

function view(
  localPhoto: string | null = "data:image/jpeg;base64,bGVnYWN5",
  cachedPhoto?: string,
) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  if (cachedPhoto !== undefined)
    queryClient.setQueryData(["profile-photo", "account-1"], {
      id: "account-1",
      user_metadata: cachedPhoto
        ? { profile_avatar: { url: cachedPhoto } }
        : {},
    });
  const onSave = vi.fn().mockResolvedValue(undefined);
  const result = render(
    <QueryClientProvider client={queryClient}>
      <ProfilePhoto
        userId="account-1"
        name="Ada"
        localPhoto={localPhoto}
        onSave={onSave}
      />
    </QueryClientProvider>,
  );
  return { ...result, queryClient, onSave };
}
beforeEach(() => {
  vi.clearAllMocks();
  mocks.signedIn = true;
  mocks.shots = undefined;
  mocks.getUser.mockResolvedValue({
    data: { user: { id: "account-1", user_metadata: {} } },
    error: null,
  });
  mocks.save.mockResolvedValue({
    id: "account-1",
    user_metadata: {
      profile_avatar: { url: "https://storage.example/new.jpg" },
    },
  });
  mocks.mirror.mockResolvedValue(undefined);
});
afterEach(cleanup);

it("saves contact photos locally", async () => {
  const { onSave } = view(null);
  fireEvent.click(screen.getByRole("button", { name: /Change photo/ }));
  await waitFor(() =>
    expect(onSave).toHaveBeenCalledWith("data:image/jpeg;base64,bmV3"),
  );
  expect(screen.getByRole("img").getAttribute("src")).toBe(
    "data:image/jpeg;base64,bmV3",
  );
  expect(mocks.getUser).not.toHaveBeenCalled();
});
it("keeps a failed change available for retry", async () => {
  const { onSave } = view(null);
  onSave.mockRejectedValueOnce(new Error("offline"));
  fireEvent.click(screen.getByRole("button", { name: /Change photo/ }));
  expect(await screen.findByRole("alert")).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Retry" }));
  await waitFor(() => expect(screen.queryByRole("alert")).toBeNull());
  expect(onSave).toHaveBeenLastCalledWith("data:image/jpeg;base64,bmV3");
});
it("removes the local contact photo", async () => {
  const { onSave } = view();
  fireEvent.click(screen.getByRole("button", { name: "Remove photo" }));
  await waitFor(() => expect(onSave).toHaveBeenCalledWith(null));
  await waitFor(() => expect(screen.queryByRole("img")).toBeNull());
});
