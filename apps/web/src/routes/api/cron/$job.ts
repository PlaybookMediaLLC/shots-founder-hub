import { createFileRoute } from "@tanstack/react-router";

export const Route = createFileRoute("/api/cron/$job")({
  server: {
    handlers: { GET: () => new Response("Not found", { status: 404 }) },
  },
});
