import {
  ArrowRight,
  CalendarBlank,
  Microphone,
  Quotes,
  Waveform,
} from "@anlg/ui/components/icons";

import { AnarlogLogo } from "@/components/anarlog-logo";

export function WorkflowSection() {
  return (
    <section
      className="pt-16 md:pt-20"
      aria-labelledby="founder-context-heading"
    >
      <h2
        id="founder-context-heading"
        className="font-hand text-fg text-3xl font-semibold"
      >
        Your work is the starting point.
      </h2>
      <p className="text-fg-muted mx-auto mt-4 max-w-lg text-base leading-7">
        Follow one idea from a spoken thought to a point of view, a content
        draft, and a place on your schedule.
      </p>

      <div className="workflow-story">
        <p className="workflow-example-label">An illustrative walkthrough</p>
        <ol className="workflow-scenes">
          <li className="workflow-capture">
            <div className="workflow-step-heading">
              <span className="workflow-step-number" aria-hidden="true">
                01
              </span>
              <h3>Start with something real</h3>
            </div>
            <div className="workflow-note bg-lined-notebook">
              <div className="workflow-note-label">
                <Microphone size={18} aria-hidden="true" />
                <span>A spoken idea / meeting excerpt</span>
              </div>
              <Waveform
                className="workflow-waveform"
                size={40}
                aria-hidden="true"
              />
              <blockquote>
                “We thought onboarding needed more instructions. What people
                actually needed was <mark>one clear first step.</mark>”
              </blockquote>
              <p className="workflow-note-footer">
                Your voice, notes, and transcripts are raw material.
              </p>
            </div>
          </li>

          <li className="workflow-takeaway">
            <div className="workflow-link" aria-hidden="true">
              <ArrowRight size={20} />
            </div>
            <div className="workflow-step-heading">
              <span className="workflow-step-number" aria-hidden="true">
                02
              </span>
              <h3>Find your point of view</h3>
            </div>
            <div className="workflow-insight">
              <Quotes size={26} aria-hidden="true" />
              <p className="workflow-eyebrow">The takeaway you choose</p>
              <blockquote>Clarity beats more instructions.</blockquote>
              <p className="workflow-insight-note">
                Your angle: make the next action obvious before adding another
                guide.
              </p>
            </div>
            <div className="workflow-link-to-draft" aria-hidden="true">
              <ArrowRight size={20} />
            </div>
          </li>

          <li className="workflow-output">
            <div
              className="workflow-link workflow-link-output"
              aria-hidden="true"
            >
              <ArrowRight size={20} />
            </div>
            <div className="workflow-step-heading">
              <span className="workflow-step-number" aria-hidden="true">
                03
              </span>
              <h3>Create, review, and schedule</h3>
            </div>
            <div className="workflow-draft">
              <div className="workflow-draft-topline">
                <AnarlogLogo className="workflow-wordmark" />
                <span className="workflow-eyebrow">Content draft</span>
              </div>
              <figure className="workflow-visual">
                <div className="workflow-visual-copy">
                  <p className="workflow-eyebrow">A lesson from building</p>
                  <h4>
                    Less explaining.
                    <br />A clearer first step.
                  </h4>
                </div>
                <div className="workflow-one-step" aria-hidden="true">
                  <span>01</span>
                  <span>One clear step</span>
                </div>
                <figcaption>
                  Illustrative visual created around the takeaway
                </figcaption>
              </figure>
              <div className="workflow-draft-copy">
                <p>
                  This week we simplified our first screen. We expected to write
                  a better guide. Instead, we gave people one clear first step.
                </p>
                <p>My takeaway: make the next action obvious.</p>
              </div>
              <div className="workflow-schedule">
                <div className="workflow-calendar-icon" aria-hidden="true">
                  <CalendarBlank size={28} />
                </div>
                <div>
                  <p className="workflow-eyebrow">Schedule preview</p>
                  <p className="workflow-schedule-time">
                    Thursday · <time dateTime="09:00">9:00 AM</time>
                  </p>
                </div>
                <span className="workflow-schedule-note">
                  After your review
                </span>
              </div>
            </div>
          </li>
        </ol>
        <p className="workflow-caption">
          Example content and timing only. You choose what to share and when.
        </p>
      </div>
    </section>
  );
}
