import { createFileRoute, redirect } from "@tanstack/react-router";

import { authSearchSchema } from "@/functions/auth-search";
import { beginShotsWebAuth } from "@/functions/shots-auth";

export const Route = createFileRoute("/auth")({
  ssr: false,
  validateSearch: authSearchSchema,
  head: () => ({ meta: [{ name: "robots", content: "noindex, nofollow" }] }),
  beforeLoad: async ({ search }) => {
    throw redirect({
      to: "/",
      reloadDocument: true,
      href: await beginShotsWebAuth({
        data: {
          returnTo: search.redirect,
          switchAccount: search.account === "switch",
        },
      }),
    });
  },
});
