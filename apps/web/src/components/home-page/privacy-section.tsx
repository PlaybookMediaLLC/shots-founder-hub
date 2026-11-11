import {
  Cloud,
  Cpu,
  type Icon as PhosphorIcon,
  Key,
} from "@anlg/ui/components/icons";
import { cn } from "@anlg/utils";

const privacyCommitments = [
  {
    title: "Keep the useful moments",
    description:
      "Notes and supported meeting capture can help you revisit a useful lesson. Get permission before recording or sharing someone else’s words.",
    visual: "meeting",
  },
  {
    title: "Keep private work private",
    description:
      "Your core desktop record is local. Choose what you take into your content workflow; AI, sync, and sharing have separate data paths.",
    visual: "files",
  },
  {
    title: "Choose your AI",
    description:
      "Choose supported local models or connect the providers that fit your workflow.",
    visual: "key",
  },
];

export function PrivacySection() {
  return (
    <section className="py-16 md:py-20">
      <div>
        <h2 className="font-hand text-fg-muted text-3xl leading-none font-semibold">
          Your ideas. Your voice. Your choices.
        </h2>
        <p className="text-fg-muted mx-auto mt-6 max-w-2xl text-lg leading-8">
          Building a personal brand starts with deciding what you want to say.
          Keep material you may want to revisit, and choose what belongs in your
          public story.
        </p>
      </div>

      <div className="relative left-1/2 mt-6 w-screen max-w-[1120px] -translate-x-1/2">
        <div className="grid gap-4 md:flex md:items-start md:justify-between md:gap-0">
          {privacyCommitments.map((commitment) => {
            return (
              <div
                key={commitment.description}
                className="flex flex-col px-6 py-3 text-center md:w-[31%] md:p-4"
              >
                <PrivacyVisual type={commitment.visual} />
                <h3 className="text-fg mt-5 text-base font-medium md:mt-7">
                  {commitment.title}
                </h3>
                <p className="text-fg-muted mx-auto mt-1 max-w-[17rem] text-sm leading-6">
                  {commitment.description}
                </p>
              </div>
            );
          })}
        </div>
      </div>
    </section>
  );
}

function PrivacyVisual({
  type,
}: {
  type: (typeof privacyCommitments)[number]["visual"];
}) {
  if (type === "files") {
    return <LocalFilesVisual />;
  }

  if (type === "key") {
    return (
      <div className="flex h-24 items-center justify-center select-none md:h-28 md:w-full">
        <div
          className="relative h-20 w-44 md:h-24 md:w-48"
          role="img"
          aria-label="AI option cards cycling between cloud, key, and chip"
        >
          <AiOptionPlayingCard
            className="ai-option-card-cloud ai-option-card-red"
            rank="C"
            IconComponent={Cloud}
          />
          <AiOptionPlayingCard
            className="ai-option-card-key"
            rank="K"
            IconComponent={Key}
          />
          <AiOptionPlayingCard
            className="ai-option-card-chip"
            rank="O"
            IconComponent={Cpu}
          />
        </div>
      </div>
    );
  }

  return <MeetingCaptureVisual />;
}

function LocalFilesVisual() {
  return (
    <div className="flex h-20 items-center justify-center gap-2 select-none md:h-28 md:w-full md:justify-between md:gap-1">
      <img
        src="/icons/file.webp"
        alt=""
        className="w-10 rotate-[3deg] object-contain transition-transform duration-300 ease-out hover:rotate-[7deg]"
        draggable={false}
      />
      <img
        src="/icons/file.webp"
        alt=""
        width={160}
        height={221}
        className="w-10 rotate-[-5deg] object-contain transition-transform duration-300 ease-out hover:rotate-[-9deg]"
        draggable={false}
      />
      <img
        src="/icons/folderchar.svg"
        alt=""
        width={1004}
        height={841}
        className="w-14 object-contain transition-transform duration-300 ease-out hover:rotate-[3deg]"
        draggable={false}
      />
      <img
        src="/icons/file.webp"
        alt=""
        width={160}
        height={221}
        className="w-10 rotate-[6deg] object-contain transition-transform duration-300 ease-out hover:rotate-[10deg]"
        draggable={false}
      />
      <img
        src="/icons/file.webp"
        alt=""
        className="w-10 rotate-[-4deg] object-contain transition-transform duration-300 ease-out hover:rotate-[-8deg]"
        draggable={false}
      />
    </div>
  );
}

function MeetingCaptureVisual() {
  return (
    <div className="flex h-20 items-center justify-center select-none md:h-28 md:w-full">
      <div className="border-border-subtle bg-page flex w-full max-w-[260px] items-center gap-3 rounded-2xl border py-2 pr-3 pl-4 text-left shadow-[0_3px_10px_rgba(24,22,19,0.04)]">
        <img
          src="/icons/google-meet.svg"
          alt=""
          className="h-7 w-7 object-contain"
          draggable={false}
        />
        <div className="flex flex-col gap-1">
          <span className="text-fg text-sm font-medium">Sprint 3 planning</span>
          <span className="text-fg-muted text-sm">5 participants</span>
        </div>
        <div
          className="meeting-audio-bars ml-auto flex h-6 items-center gap-0.5"
          aria-hidden="true"
        >
          <span className="meeting-audio-bar" />
          <span className="meeting-audio-bar" />
          <span className="meeting-audio-bar" />
        </div>
      </div>
    </div>
  );
}

function AiOptionPlayingCard({
  className,
  rank,
  IconComponent,
}: {
  className: string;
  rank: string;
  IconComponent: PhosphorIcon;
}) {
  return (
    <div className={cn(["ai-option-card", className])}>
      <span className="ai-option-card-corner ai-option-card-corner-top">
        <span className="ai-option-card-rank">{rank}</span>
      </span>
      <div className="ai-option-card-face">
        <IconComponent aria-hidden="true" />
      </div>
      <span className="ai-option-card-corner ai-option-card-corner-bottom">
        <span className="ai-option-card-rank">{rank}</span>
      </span>
    </div>
  );
}
