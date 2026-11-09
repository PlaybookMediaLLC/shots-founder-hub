import { Link } from "@tanstack/react-router";

import { ArrowRight } from "@anlg/ui/components/icons";

import { AnarlogLogo } from "@/components/anarlog-logo";

export function HeroSection() {
  return (
    <section className="isolate pt-10 pb-2 md:pt-12 md:pb-4">
      <Link to="/" aria-label="Shots Founder Hub home" className="inline-flex">
        <AnarlogLogo className="h-8 w-auto md:h-9" />
      </Link>
      <h1 className="font-hand mx-auto mt-12 max-w-3xl text-4xl leading-tight font-semibold tracking-normal text-balance sm:text-5xl md:mt-16 md:text-6xl">
        Build your personal brand from the work you already do
      </h1>
      <p className="text-fg-muted mx-auto mt-6 max-w-2xl text-lg leading-8">
        Speak your ideas or extract takeaways from meeting notes and
        transcripts. Create content and visuals with Shots, then review and
        schedule your content.
      </p>
      <div className="mt-8 flex flex-wrap items-center justify-center gap-x-5 gap-y-3 text-sm">
        <a
          href="#founder-context-heading"
          className="bg-brand-dark text-surface inline-flex items-center gap-2 rounded-full px-5 py-3 font-medium"
        >
          Explore the workflow
          <ArrowRight size={16} weight="bold" aria-hidden="true" />
        </a>
        <Link to="/download/" className="text-fg underline underline-offset-4">
          Explore capture tools
        </Link>
      </div>
    </section>
  );
}
