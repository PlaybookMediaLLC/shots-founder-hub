import { createFileRoute, redirect } from "@tanstack/react-router";

export const Route = createFileRoute("/discord")({
  beforeLoad: () => {
    throw redirect({
      to: "/",
    } as any);
  },
});
