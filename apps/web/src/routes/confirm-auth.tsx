import { createFileRoute, redirect } from "@tanstack/react-router";

export const Route = createFileRoute("/confirm-auth")({
  beforeLoad: () => {
    throw redirect({ to: "/auth/", search: { flow: "web" } });
  },
});
