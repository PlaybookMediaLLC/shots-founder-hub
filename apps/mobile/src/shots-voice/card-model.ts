import type { VoiceCommand } from "./model.ts";

// The voice command confirmation card (plan 5.4 step 6). Shots re-runs every
// check at confirm (K22); these rules only keep the card honest.

/** Shots' per-platform post limits (content_draft_schedule.go). */
const POST_LIMITS: Record<string, number> = {
  tiktok: 2000,
  youtube: 5000,
  bluesky: 300,
  instagram: 2200,
  linkedin: 3000,
  mastodon: 500,
  threads: 500,
  x: 280,
};
/** The longest text a command carries. */
export const MAX_COMMAND_TEXT = 2000;

const PLATFORM_NAMES: Record<string, string> = {
  x: "X",
  linkedin: "LinkedIn",
  instagram: "Instagram",
  threads: "Threads",
  bluesky: "Bluesky",
  mastodon: "Mastodon",
  tiktok: "TikTok",
  youtube: "YouTube",
};

export function platformName(platform: string | null): string {
  return platform ? (PLATFORM_NAMES[platform] ?? platform) : "the platform";
}

const isEmojiJoiner = (code: number) =>
  code === 0x200d ||
  (code >= 0xfe00 && code <= 0xfe0f) ||
  (code >= 0x1f3fb && code <= 0x1f3ff);

// shortcut: approximates twitter-text v3 (links count 23, CJK and emoji count 2,
// an emoji sequence counts once); Shots' parser decides at confirm.
function xLength(text: string): number {
  let length = 0;
  const rest = text
    .trim()
    .normalize("NFC")
    .replace(/(?:https?:\/\/|www\.)\S+/gi, () => {
      length += 23;
      return "";
    });
  let joined = false;
  let regional = false;
  for (const char of rest) {
    const code = char.codePointAt(0)!;
    if (isEmojiJoiner(code)) {
      joined = code === 0x200d;
      continue;
    }
    const isRegional = code >= 0x1f1e6 && code <= 0x1f1ff;
    if (joined || (isRegional && regional)) {
      joined = false;
      regional = false;
      continue;
    }
    regional = isRegional;
    length +=
      code <= 4351 ||
      (code >= 8192 && code <= 8205) ||
      (code >= 8208 && code <= 8223) ||
      (code >= 8242 && code <= 8247)
        ? 1
        : 2;
  }
  return length;
}

/** A post's length as its platform counts it: X's weighting, graphemes on Bluesky, UTF-16 units elsewhere. */
export function postLength(platform: string | null, text: string): number {
  if (platform === "x") return xLength(text);
  if (platform === "bluesky") {
    const Segmenter = (
      Intl as unknown as {
        Segmenter?: new (
          locale?: string,
          options?: { granularity: "grapheme" },
        ) => { segment: (text: string) => Iterable<unknown> };
      }
    ).Segmenter;
    return Segmenter
      ? [...new Segmenter(undefined, { granularity: "grapheme" }).segment(text)]
          .length
      : [...text].length;
  }
  return text.length;
}

export function postLimit(platform: string | null): number | null {
  return platform ? (POST_LIMITS[platform] ?? null) : null;
}

/** Why Confirm is disabled, or null when the card may be confirmed (K6). */
export function confirmIssue(input: {
  action: string;
  platform: string | null;
  text: string;
  channelConnectionId: string | null;
  localTime: string | null;
}): string | null {
  const text = input.text.trim();
  if (!text) return "Add the post text.";
  if ([...text].length > MAX_COMMAND_TEXT)
    return "Shorten the post to 2,000 characters.";
  const limit = postLimit(input.platform);
  if (limit !== null && postLength(input.platform, input.text) > limit)
    return `Shorten the post to ${limit} characters for ${platformName(input.platform)}.`;
  if (input.action !== "schedule_post") return null;
  if (!input.channelConnectionId) return "Pick the account to post from.";
  if (!input.localTime) return "Enter the date and time to post.";
  return null;
}

/** A wall-clock time from the card's fields, or null when they are not a valid date and time. */
export function wallTime(date: string, time: string): string | null {
  const day = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date.trim());
  const clock = /^(\d{1,2}):(\d{2})$/.exec(time.trim());
  if (!day || !clock) return null;
  const [year, month, dayOfMonth] = day.slice(1).map(Number) as [
    number,
    number,
    number,
  ];
  const [hour, minute] = clock.slice(1).map(Number) as [number, number];
  const check = new Date(Date.UTC(year, month - 1, dayOfMonth));
  if (
    check.getUTCMonth() !== month - 1 ||
    check.getUTCDate() !== dayOfMonth ||
    hour > 23 ||
    minute > 59
  )
    return null;
  return `${day[0]}T${String(hour).padStart(2, "0")}:${clock[2]}`;
}

/** The proposal text split into runs, with the words Shots added (not spoken) marked (K17). */
export function highlightAddedWords(
  text: string,
  addedWords: string[],
): { text: string; added: boolean }[] {
  const runs: { text: string; added: boolean }[] = [];
  const push = (part: string, added: boolean) => {
    if (!part) return;
    const last = runs.at(-1);
    if (last && last.added === added) last.text += part;
    else runs.push({ text: part, added });
  };
  let next = 0;
  let index = 0;
  // Words as Shots splits them: letters, digits and apostrophes.
  for (const match of text.matchAll(/[\p{L}\p{N}'’]+/gu)) {
    const word = match[0].replace(/^['’]+|['’]+$/g, "");
    push(text.slice(index, match.index), false);
    const added = next < addedWords.length && word === addedWords[next];
    if (added) next += 1;
    push(match[0], added);
    index = match.index + match[0].length;
  }
  push(text.slice(index), false);
  return runs;
}

const WALL_TIME = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/;

/** The full date, time and zone the proposal names (K3, K24). */
export function formatProposalTime(
  command: Pick<VoiceCommand, "scheduledFor" | "localTime" | "timeZone">,
  locale?: string,
): string | null {
  const parts = {
    weekday: "long",
    year: "numeric",
    month: "long",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  } as const;
  try {
    if (command.scheduledFor) {
      const formatted = new Intl.DateTimeFormat(locale, {
        ...parts,
        timeZone: command.timeZone,
        timeZoneName: "short",
      }).format(new Date(command.scheduledFor));
      return `${formatted} (${command.timeZone})`;
    }
    const wall = command.localTime ? WALL_TIME.exec(command.localTime) : null;
    if (!wall) return null;
    const [year, month, day, hour, minute] = wall.slice(1).map(Number) as [
      number,
      number,
      number,
      number,
      number,
    ];
    // The wall time as spoken, without converting it between zones.
    const formatted = new Intl.DateTimeFormat(locale, {
      ...parts,
      timeZone: "UTC",
    }).format(new Date(Date.UTC(year, month - 1, day, hour, minute)));
    return `${formatted} (${command.timeZone})`;
  } catch {
    return null;
  }
}

/** Guessed or flagged fields, asked as questions (K2, K4, K5, K16, K17). */
export function cardQuestions(
  command: Pick<VoiceCommand, "action" | "guessed" | "flags">,
): string[] {
  const flags = new Set(command.flags);
  const guessed = new Set(command.guessed);
  const questions: string[] = [];
  if (command.action === "schedule_post") {
    if (flags.has("time_missing"))
      questions.push("When should this be posted?");
    else if (flags.has("time_past"))
      questions.push(
        "That time has passed. When should this be posted instead?",
      );
    else if (flags.has("time_too_far"))
      questions.push(
        "That time is more than a year away. When should this be posted?",
      );
    else if (flags.has("time_gap") || flags.has("time_ambiguous"))
      questions.push(
        "That time is skipped or happens twice when the clocks change. Which time did you mean?",
      );
    else if (flags.has("time_invalid"))
      questions.push(
        "Shots could not read that time. When should this be posted?",
      );
    else if (guessed.has("local_time"))
      questions.push("Is this the day and time you meant?");
  }
  if (flags.has("platform_ambiguous"))
    questions.push("Which account should post this?");
  else if (guessed.has("platform"))
    questions.push("Is this the right account?");
  if (flags.has("text_added_words"))
    questions.push(
      "Is this what you want to post? The highlighted words were not in your recording.",
    );
  else if (guessed.has("text"))
    questions.push("Is this what you want to post?");
  return questions;
}

/** What the card says once the proposal is no longer open. */
export function commandStatusText(
  command: Pick<VoiceCommand, "status" | "outcome" | "notice">,
  scheduledTime: string | null,
): string | null {
  switch (command.status) {
    case "waiting":
      return "Shots is still reading this note for a command.";
    case "expired":
      return "This proposal expired. Nothing was posted.";
    case "withdrawn":
      return "This proposal was withdrawn because the transcript changed.";
    case "failed":
      return (
        command.notice ??
        "Shots could not understand this as a command. The note is kept as an ordinary note."
      );
    case "confirmed":
      return command.outcome === "scheduled"
        ? `Scheduled${scheduledTime ? ` for ${scheduledTime}` : ""}.`
        : command.outcome === "pending_approval"
          ? "Sent for approval. It is scheduled once it is approved."
          : "Saved as a draft in Shots.";
    default:
      return null;
  }
}
