import assert from "node:assert/strict";
import test from "node:test";

import {
  cardQuestions,
  commandStatusText,
  confirmIssue,
  formatProposalTime,
  highlightAddedWords,
  postLength,
  wallTime,
} from "./card-model.ts";

const schedule = {
  action: "schedule_post",
  platform: "x",
  channelConnectionId: "conn-1",
  localTime: "2026-11-12T10:00",
};

test("Confirm is blocked over the platform limit until the text is edited", () => {
  assert.equal(confirmIssue({ ...schedule, text: "a".repeat(280) }), null);
  assert.equal(
    confirmIssue({ ...schedule, text: "a".repeat(281) }),
    "Shorten the post to 280 characters for X.",
  );
  // X counts a link as 23 and CJK as 2.
  assert.equal(
    postLength("x", `${"a".repeat(250)} https://example.com/${"p".repeat(80)}`),
    274,
  );
  assert.equal(postLength("x", "漢字"), 4);
  assert.equal(postLength("x", "👨‍👩‍👧 🇺🇸"), 5);
  assert.equal(
    confirmIssue({ ...schedule, platform: "linkedin", text: "a".repeat(2001) }),
    "Shorten the post to 2,000 characters.",
  );
  assert.equal(confirmIssue({ ...schedule, text: "  " }), "Add the post text.");
  assert.equal(
    confirmIssue({ ...schedule, text: "Hi", channelConnectionId: null }),
    "Pick the account to post from.",
  );
  assert.equal(
    confirmIssue({ ...schedule, text: "Hi", localTime: null }),
    "Enter the date and time to post.",
  );
  assert.equal(
    confirmIssue({
      ...schedule,
      action: "create_draft",
      platform: null,
      channelConnectionId: null,
      localTime: null,
      text: "Hi",
    }),
    null,
  );
});

test("the card's date and time fields make one wall-clock time or none", () => {
  assert.equal(wallTime("2026-11-12", "9:05"), "2026-11-12T09:05");
  assert.equal(wallTime("2026-02-30", "10:00"), null);
  assert.equal(wallTime("2026-11-12", "24:00"), null);
  assert.equal(wallTime("tomorrow", "10:00"), null);
});

test("words Shots added to the spoken text are highlighted in order", () => {
  assert.deepEqual(
    highlightAddedWords("Entrepreneurship is really hard, folks.", [
      "really",
      "folks",
    ]),
    [
      { text: "Entrepreneurship is ", added: false },
      { text: "really", added: true },
      { text: " hard, ", added: false },
      { text: "folks", added: true },
      { text: ".", added: false },
    ],
  );
  assert.deepEqual(highlightAddedWords("Hard is hard.", ["hard"]), [
    { text: "Hard is ", added: false },
    { text: "hard", added: true },
    { text: ".", added: false },
  ]);
});

test("the proposal shows the full date, time and the recording's zone", () => {
  const scheduled = formatProposalTime(
    {
      scheduledFor: "2026-11-12T15:00:00Z",
      localTime: "2026-11-12T10:00",
      timeZone: "America/New_York",
    },
    "en-US",
  );
  for (const part of [
    "Thursday",
    "November",
    "12",
    "2026",
    "10:00",
    "EST",
    "(America/New_York)",
  ])
    assert.ok(scheduled.includes(part), `${scheduled} names ${part}`);
  // A time that could not be resolved is shown as spoken, never shifted.
  const spoken = formatProposalTime(
    {
      scheduledFor: null,
      localTime: "2026-03-08T02:30",
      timeZone: "America/New_York",
    },
    "en-US",
  );
  for (const part of ["Sunday", "March", "8", "2:30", "(America/New_York)"])
    assert.ok(spoken.includes(part), `${spoken} names ${part}`);
  assert.equal(
    formatProposalTime({
      scheduledFor: null,
      localTime: null,
      timeZone: "UTC",
    }),
    null,
  );
});

test("guessed and flagged fields become questions on the card", () => {
  assert.deepEqual(
    cardQuestions({
      action: "schedule_post",
      guessed: ["local_time", "platform"],
      flags: ["time_ambiguous", "platform_ambiguous", "text_added_words"],
    }),
    [
      "That time is skipped or happens twice when the clocks change. Which time did you mean?",
      "Which account should post this?",
      "Is this what you want to post? The highlighted words were not in your recording.",
    ],
  );
  assert.deepEqual(
    cardQuestions({
      action: "schedule_post",
      guessed: ["local_time"],
      flags: ["tomorrow_after_midnight"],
    }),
    ["Is this the day and time you meant?"],
  );
  assert.deepEqual(
    cardQuestions({
      action: "schedule_post",
      guessed: [],
      flags: ["time_past"],
    }),
    ["That time has passed. When should this be posted instead?"],
  );
  assert.deepEqual(
    cardQuestions({ action: "create_draft", guessed: [], flags: [] }),
    [],
  );
});

test("closed proposals say what happened and nothing more", () => {
  assert.equal(
    commandStatusText(
      { status: "proposed", outcome: null, notice: null },
      null,
    ),
    null,
  );
  assert.equal(
    commandStatusText({ status: "expired", outcome: null, notice: null }, null),
    "This proposal expired. Nothing was posted.",
  );
  assert.equal(
    commandStatusText(
      { status: "confirmed", outcome: "scheduled", notice: null },
      "Thursday 10:00",
    ),
    "Scheduled for Thursday 10:00.",
  );
  assert.equal(
    commandStatusText(
      { status: "confirmed", outcome: "pending_approval", notice: null },
      null,
    ),
    "Sent for approval. It is scheduled once it is approved.",
  );
  assert.equal(
    commandStatusText(
      { status: "confirmed", outcome: "draft", notice: null },
      null,
    ),
    "Saved as a draft in Shots.",
  );
  assert.equal(
    commandStatusText(
      { status: "failed", outcome: null, notice: "Only text posts." },
      null,
    ),
    "Only text posts.",
  );
});
