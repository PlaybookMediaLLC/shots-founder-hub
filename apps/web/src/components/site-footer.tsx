import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";

import { fetchUser } from "@/functions/auth";

const footerGroups = [
  {
    title: "Product",
    links: [{ label: "Download", to: "/download/" }],
  },
  {
    title: "Company",
    links: [{ label: "About", to: "/about/" }],
  },
  {
    title: "Legal",
    links: [
      { label: "Privacy", to: "/privacy/" },
      { label: "Terms", to: "/terms/" },
    ],
  },
];

export function SiteFooter() {
  const { data: user } = useQuery({
    queryKey: ["auth-user"],
    queryFn: () => fetchUser(),
  });

  return (
    <footer className="text-fg mx-auto flex w-full max-w-6xl flex-col gap-10 px-5 py-10 text-xs sm:flex-row sm:justify-between md:px-8">
      <div className="flex flex-col gap-2.5 self-start">
        <Link to="/" className="text-fg text-sm font-medium">
          Shots Founder Hub
        </Link>
        <p className="text-fg-muted max-w-48 text-xs leading-5">
          © {new Date().getFullYear()} Playbook Media Interactive LLC
        </p>
        <a
          href="mailto:team@playbookmedia.io"
          className="text-fg-muted hover:text-fg w-fit"
        >
          Contact Playbook
        </a>
        {user ? (
          <Link to="/app/account/" className="hover:text-fg w-fit">
            Account
          </Link>
        ) : (
          <Link
            to="/auth/"
            search={{ flow: "web" }}
            className="hover:text-fg w-fit"
          >
            Get started
          </Link>
        )}
      </div>
      <nav className="grid grid-cols-2 gap-x-12 gap-y-8 sm:grid-cols-3 sm:gap-x-12">
        {footerGroups.map((group) => (
          <div key={group.title} className="flex flex-col gap-2.5">
            <span className="tracking-[0.04em] text-[#756b5d]">
              {group.title}
            </span>
            {group.links.map((link) => (
              <Link
                key={link.label}
                to={link.to}
                className="hover:text-fg w-fit"
              >
                {link.label}
              </Link>
            ))}
          </div>
        ))}
      </nav>
    </footer>
  );
}
