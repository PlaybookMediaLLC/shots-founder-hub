import "./dictation-section.css";

import { Link } from "@tanstack/react-router";
import { useReducedMotion } from "motion/react";
import { useEffect, useId, useRef, useState } from "react";

import { useMountEffect } from "@/hooks/useMountEffect";

const rawSpeechParts = [
  { text: "um ", filler: true },
  { text: "this week we simplified our onboarding. ", filler: false },
  { text: "you know ", filler: true },
  { text: "we thought people needed more instructions. ", filler: false },
  { text: "like ", filler: true },
  { text: "what they needed was one clear first step. ", filler: false },
  { text: "uh ", filler: true },
  { text: "we removed three choices from the first screen. ", filler: false },
  { text: "I mean ", filler: true },
  {
    text: "the lesson for me was to make the next action obvious. ",
    filler: false,
  },
  { text: "so, um ", filler: true },
  { text: "that is the idea I want to share in my next post. ", filler: false },
];

const polishedSpeech =
  "This week we simplified our onboarding. We thought people needed more instructions. What they needed was one clear first step. We removed three choices from the first screen. The lesson for me was to make the next action obvious. That is the idea I want to share in my next post. ";

const rawSpeech = rawSpeechParts.map((part) => part.text).join("");
const streamCopies = 3;
const rawSpeechStreamParts = Array.from(
  { length: streamCopies },
  (_, repeatIndex) =>
    rawSpeechParts.map((part, partIndex) => ({
      ...part,
      id: `${repeatIndex}-${partIndex}`,
    })),
).flat();
const polishedSpeechStream = polishedSpeech.repeat(streamCopies);

export function DictationSection() {
  return (
    <section id="dictation" className="pt-16 md:pt-20">
      <h2 className="text-color font-hand text-3xl leading-none font-semibold">
        Say the idea before you lose it.
      </h2>
      <p className="text-color mx-auto mt-6 max-w-xl text-lg leading-8">
        Speak a lesson, a strong opinion, or the start of a post. Turn it into
        content and visuals with Shots, then review and schedule your content.
      </p>
      <SpeechFlowVisual />
    </section>
  );
}

function SpeechFlowVisual() {
  const id = useId();
  const reducedMotion = useReducedMotion();
  const stageRef = useRef<HTMLDivElement>(null);
  const svgRef = useRef<SVGSVGElement>(null);
  const [edges, setEdges] = useState({ left: -80, right: 1180 });
  const rawRef = useRef<SVGTextElement>(null);
  const polishedRef = useRef<SVGTextElement>(null);
  const rawPathRef = useRef<SVGPathElement>(null);
  const [lengths, setLengths] = useState({ raw: 0, polished: 0, path: 0 });

  useMountEffect(() => {
    let active = true;
    const measure = () => {
      if (
        !active ||
        !rawRef.current ||
        !polishedRef.current ||
        !rawPathRef.current
      )
        return;
      if (stageRef.current && svgRef.current) {
        const scale = svgRef.current.clientWidth / 1180;
        const halfWidth = stageRef.current.clientWidth / scale / 2 + 32;
        const left = Math.min(-80, 590 - halfWidth);
        const right = Math.max(1180, 590 + halfWidth);
        setEdges((previous) =>
          previous.left === left && previous.right === right
            ? previous
            : { left, right },
        );
      }
      const next = {
        raw: rawRef.current.getComputedTextLength() / streamCopies,
        polished: polishedRef.current.getComputedTextLength() / streamCopies,
        path: rawPathRef.current.getTotalLength(),
      };
      setLengths((previous) =>
        previous.raw === next.raw &&
        previous.polished === next.polished &&
        previous.path === next.path
          ? previous
          : next,
      );
    };
    void document.fonts.ready.then(measure);
    const observer = new ResizeObserver(measure);
    if (svgRef.current) observer.observe(svgRef.current);
    if (stageRef.current) observer.observe(stageRef.current);
    return () => {
      active = false;
      observer.disconnect();
    };
  });

  useEffect(() => {
    if (rawPathRef.current) {
      const path = rawPathRef.current.getTotalLength();
      setLengths((previous) => ({ ...previous, path }));
    }
  }, [edges.left]);

  const rawStart = lengths.path - lengths.raw * 2;
  const polishedStart = -lengths.polished;
  const ribbonTail = edges.right - 1180;
  const animated = !reducedMotion && lengths.raw > 0 && lengths.polished > 0;

  return (
    <div
      ref={stageRef}
      className="speech-flow-stage"
      aria-label="Illustrative dictation example: a founder reflects on an onboarding lesson"
    >
      <p className="sr-only">
        Rough speech: {rawSpeech}. Polished text: {polishedSpeech}
      </p>
      <svg
        ref={svgRef}
        className="speech-flow-svg"
        viewBox="0 0 1180 360"
        preserveAspectRatio="xMidYMid meet"
        aria-hidden="true"
      >
        <path
          ref={rawPathRef}
          id={`${id}-raw`}
          d={`M${edges.left} 226 H-80 C -10 226 20 184 90 184 C 160 184 170 266 240 250 C 310 234 330 156 400 166 C 442 172 466 176 500 176`}
        />
        <path
          id={`${id}-polished`}
          className="speech-flow-ribbon"
          d={`M650 176 C 730 176 750 204 820 196 C 890 188 910 132 980 124 C 1050 116 1110 144 1180 96 C ${1180 + ribbonTail / 3} ${96 - (ribbonTail * 48) / 210} ${1180 + (2 * ribbonTail) / 3} ${96 - ribbonTail / 2} ${edges.right} ${96 - ribbonTail * 0.65}`}
        />
        <text
          ref={rawRef}
          className="speech-flow-text speech-flow-text--raw"
          x={lengths.raw > 0 ? rawStart : -120}
        >
          <textPath href={`#${id}-raw`}>
            {rawSpeechStreamParts.map((part) => (
              <tspan
                key={part.id}
                className={part.filler ? "speech-flow-filler" : undefined}
              >
                {part.text}
              </tspan>
            ))}
          </textPath>
          {animated && (
            <animate
              attributeName="x"
              dur="75s"
              values={`${rawStart};${rawStart + lengths.raw}`}
              repeatCount="indefinite"
            />
          )}
        </text>
        <text
          ref={polishedRef}
          className="speech-flow-text speech-flow-text--polished"
          x={polishedStart}
        >
          <textPath href={`#${id}-polished`}>{polishedSpeechStream}</textPath>
          {animated && (
            <animate
              attributeName="x"
              begin="0.8s"
              dur="75s"
              values={`${polishedStart};0`}
              repeatCount="indefinite"
            />
          )}
        </text>
      </svg>

      <Link className="speech-flow-control" to="/download/">
        <span className="speech-flow-bars" aria-hidden="true">
          <span />
          <span />
          <span />
        </span>
        <span className="speech-flow-control__label">Explore dictation</span>
      </Link>
    </div>
  );
}
