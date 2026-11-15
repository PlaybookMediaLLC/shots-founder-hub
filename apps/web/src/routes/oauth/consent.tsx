import { createFileRoute, redirect } from "@tanstack/react-router";
export const Route = createFileRoute("/oauth/consent")({
  beforeLoad: () => {
    throw redirect({ to: "/auth/", search: { flow: "web" } });
  },
});
