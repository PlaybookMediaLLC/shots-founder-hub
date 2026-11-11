import "./index.css";

import { Link } from "@tanstack/react-router";

import { ArrowRight } from "@anlg/ui/components/icons";

import { SiteFooter } from "@/components/site-footer";

import { DictationSection } from "./dictation-section";
import { HeroSection } from "./hero-section";
import { PrivacySection } from "./privacy-section";
import { WorkflowSection } from "./workflow-section";

const founderLetter = [
  "When you’re building a company, you’re also building a point of view. The experiments you run, the choices you make, and the lessons you learn give you something worth sharing.",
  "But turning that experience into content can feel like another job. Ideas get lost in notes, a blank page slows you down, and finding the right words and visuals takes time.",
  "Shots Founder Hub is built around a simple promise: build your personal brand from the work you already do. Speak an idea or extract a takeaway from meeting notes or a transcript. Add your own perspective, create content and visuals with Shots, then review and schedule your content.",
  "The goal is to make room for your voice, not give you a script to imitate. You choose what becomes public, what stays private, and what’s ready to share.",
];

export function HomePage() {
  return (
    <main className="founder-home bg-surface text-fg min-h-screen">
      <div className="mx-auto w-full max-w-[700px] px-5 pt-4 pb-8 md:px-8 md:pt-4 md:pb-12">
        <div className="min-w-0 text-center">
          <HeroSection />
          <WorkflowSection />
          <PrivacySection />
          <DictationSection />

          <section
            id="manifesto"
            className="pt-20 pb-14 md:pt-24 md:pb-16"
            aria-labelledby="founder-note-heading"
          >
            <article className="bg-page border-border-subtle rounded-md border px-7 py-9 text-left sm:px-10 sm:py-12">
              <h2
                id="founder-note-heading"
                className="font-hand text-fg text-3xl font-semibold"
              >
                A note from Playbook
              </h2>
              <div className="text-fg-muted mt-6 space-y-6">
                {founderLetter.map((paragraph) => (
                  <p key={paragraph} className="text-lg leading-8">
                    {paragraph}
                  </p>
                ))}
              </div>
              <p className="text-fg mt-8 text-sm font-medium">
                Playbook Media Interactive LLC
              </p>
            </article>
          </section>

          <section className="py-16 md:py-20">
            <h2 className="font-hand text-fg text-4xl leading-tight font-semibold text-balance md:text-5xl">
              Start with one idea worth sharing.
            </h2>
            <p className="text-fg-muted mx-auto mt-6 max-w-2xl text-lg leading-8">
              Speak an idea or revisit a meeting takeaway. Create content and
              visuals with Shots, add your point of view, and schedule your
              content when it is ready.
            </p>
            <Link
              to="/download/"
              className="bg-brand-dark text-surface mt-8 inline-flex items-center gap-2 rounded-full px-5 py-3 text-sm font-medium"
            >
              Explore capture tools
              <ArrowRight size={16} weight="bold" aria-hidden="true" />
            </Link>
          </section>
        </div>
      </div>
      <SiteFooter />
    </main>
  );
}
