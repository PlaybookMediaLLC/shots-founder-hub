import { createFileRoute, redirect } from "@tanstack/react-router";

export const Route = createFileRoute("/_view/callback/auth")({
  beforeLoad: () => {
    throw redirect({ to: "/auth/", search: { flow: "web" } });
  },
});
