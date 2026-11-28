import { createFileRoute, redirect } from "@tanstack/react-router";

export const Route = createFileRoute("/update-password")({
  beforeLoad: () => {
    throw redirect({ to: "/auth/", search: { flow: "web" } });
  },
});
