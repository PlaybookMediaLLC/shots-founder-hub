import { createFileRoute } from "@tanstack/react-router";

import { finishShotsWebAuth } from "@/functions/shots-auth";

export const Route = createFileRoute("/_view/callback/shots")({
  server: { handlers: { GET: ({ request }) => finishShotsWebAuth(request) } },
});
