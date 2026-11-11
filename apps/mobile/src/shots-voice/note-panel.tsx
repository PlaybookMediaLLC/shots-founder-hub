import { useForm } from "@tanstack/react-form";
import { useMutation } from "@tanstack/react-query";
import { useRef } from "react";
import {
  AccessibilityInfo,
  Pressable,
  Text,
  TextInput,
  View,
} from "react-native";

import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Radius, Spacing, Typography } from "@/constants/theme";
import { env } from "@/lib/env";
import { createStyleHook, useColors } from "@/settings/theme-provider";

import {
  cardQuestions,
  commandStatusText,
  confirmBody,
  confirmIssue,
  formatProposalTime,
  highlightAddedWords,
  postLength,
  postLimit,
  wallTime,
} from "./card-model";
import { voiceNoteStatusText, type VoiceCommand } from "./model";
import { confirmShotsVoiceCommand } from "./runner";
import { useShotsVoice } from "./store";

/** The note's Shots state and, when Shots proposed a post, its confirmation card (plan 5.4 step 6). */
export function ShotsVoiceNotePanel({ sessionId }: { sessionId: string }) {
  const styles = useStyles();
  const voice = useShotsVoice();
  const note = voice.notes.find((item) => item.sessionId === sessionId);
  if (!env.shotsUrl || !note || note.localDeleted) return null;
  const command = !note.deletedRemote && note.remoteId ? note.command : null;
  return (
    <Card
      style={styles.card}
      tone={
        note.deletedRemote || note.failed || note.rejected ? "alert" : "muted"
      }
    >
      <Text accessibilityLiveRegion="polite" style={styles.status}>
        {voiceNoteStatusText(note)}
        {voice.prefs.workspaceName ? ` · ${voice.prefs.workspaceName}` : ""}
      </Text>
      {command && (
        <CommandCard
          key={`${command.id}:${command.status}:${command.transcriptRevisionId}`}
          sessionId={sessionId}
          command={command}
        />
      )}
    </Card>
  );
}

function CommandCard({
  sessionId,
  command,
}: {
  sessionId: string;
  command: VoiceCommand;
}) {
  const styles = useStyles();
  const Colors = useColors();
  const time = formatProposalTime(command);
  const [date = "", clock = ""] = command.localTime?.split("T") ?? [];
  const form = useForm({
    defaultValues: {
      text: command.text ?? "",
      channelConnectionId:
        command.channelConnectionId ??
        (command.candidates.length === 1
          ? command.candidates[0]!.channelConnectionId
          : ""),
      date,
      clock,
    },
  });
  const confirming = useRef(false);
  const confirm = useMutation({
    mutationFn: (body: Parameters<typeof confirmShotsVoiceCommand>[1]) =>
      confirmShotsVoiceCommand(sessionId, body),
    onSuccess: (result) =>
      AccessibilityInfo.announceForAccessibility(
        commandStatusText(result, formatProposalTime(result)) ?? "Confirmed.",
      ),
    onError: (error) =>
      AccessibilityInfo.announceForAccessibility(
        error instanceof Error ? error.message : "Could not confirm.",
      ),
    onSettled: () => {
      confirming.current = false;
    },
  });

  if (command.status !== "proposed") {
    return (
      <View style={styles.section}>
        <Text style={styles.body}>{commandStatusText(command, time)}</Text>
        {command.status === "confirmed" && command.notice && (
          <Text style={styles.caption}>{command.notice}</Text>
        )}
      </View>
    );
  }

  const schedule = command.action === "schedule_post";
  const questions = cardQuestions(command);
  return (
    <View style={styles.section}>
      <Text accessibilityRole="header" style={styles.title}>
        {schedule ? "Schedule this post?" : "Save this post as a draft?"}
      </Text>
      {command.notice && <Text style={styles.caption}>{command.notice}</Text>}
      {questions.map((question) => (
        <Text key={question} style={styles.question}>
          {question}
        </Text>
      ))}
      {command.addedWords.length > 0 && command.text && (
        <Text
          accessibilityLabel={`Proposed post. Words not in your recording: ${command.addedWords.join(", ")}`}
          style={styles.body}
        >
          {highlightAddedWords(command.text, command.addedWords).map(
            (run, index) => (
              <Text
                key={index}
                style={
                  run.added
                    ? [styles.added, { backgroundColor: Colors.alert }]
                    : undefined
                }
              >
                {run.text}
              </Text>
            ),
          )}
        </Text>
      )}
      <form.Subscribe selector={(state) => state.values}>
        {(values) => {
          const candidate = command.candidates.find(
            (item) => item.channelConnectionId === values.channelConnectionId,
          );
          const platform = candidate?.platform || command.platform;
          const limit = postLimit(platform);
          const localTime = wallTime(values.date, values.clock);
          const issue = confirmIssue({
            action: command.action,
            platform,
            text: values.text,
            channelConnectionId: values.channelConnectionId || null,
            localTime,
          });
          return (
            <>
              <TextInput
                accessibilityLabel="Post text"
                defaultValue={command.text ?? ""}
                multiline
                onChangeText={(text) => form.setFieldValue("text", text)}
                style={styles.input}
              />
              <Text
                accessibilityLabel={
                  limit === null
                    ? undefined
                    : `${postLength(platform, values.text)} of ${limit} characters`
                }
                style={styles.caption}
              >
                {limit === null
                  ? ""
                  : `${postLength(platform, values.text)} / ${limit}`}
              </Text>
              {command.candidates.length > 1 && (
                <View accessibilityRole="radiogroup" style={styles.choices}>
                  {command.candidates.map((item) => {
                    const checked =
                      item.channelConnectionId === values.channelConnectionId;
                    return (
                      <Pressable
                        key={item.channelConnectionId}
                        accessibilityRole="radio"
                        accessibilityState={{ checked }}
                        accessibilityLabel={`Post from ${item.name} on ${item.platform}`}
                        onPress={() =>
                          form.setFieldValue(
                            "channelConnectionId",
                            item.channelConnectionId,
                          )
                        }
                        style={[
                          styles.choice,
                          checked && { borderColor: Colors.ink },
                        ]}
                      >
                        <Text style={styles.body}>{item.name}</Text>
                      </Pressable>
                    );
                  })}
                </View>
              )}
              {command.candidates.length === 1 && (
                <Text
                  style={styles.caption}
                >{`Account: ${command.candidates[0]!.name}`}</Text>
              )}
              {schedule && (
                <>
                  <Text style={styles.body}>{time ?? "No time set yet."}</Text>
                  <View style={styles.choices}>
                    <TextInput
                      accessibilityLabel={`Post date, year-month-day, in ${command.timeZone}`}
                      defaultValue={date}
                      placeholder="2026-11-12"
                      onChangeText={(value) =>
                        form.setFieldValue("date", value)
                      }
                      style={[styles.input, styles.field]}
                    />
                    <TextInput
                      accessibilityLabel={`Post time, 24-hour, in ${command.timeZone}`}
                      defaultValue={clock}
                      placeholder="10:00"
                      onChangeText={(value) =>
                        form.setFieldValue("clock", value)
                      }
                      style={[styles.input, styles.field]}
                    />
                  </View>
                  <Text
                    style={styles.caption}
                  >{`Time zone: ${command.timeZone}, where you recorded this note.`}</Text>
                </>
              )}
              {issue && <Text style={styles.caption}>{issue}</Text>}
              {confirm.error && (
                <Text accessibilityRole="alert" style={styles.caption}>
                  {confirm.error instanceof Error
                    ? confirm.error.message
                    : "Could not confirm."}
                </Text>
              )}
              <Button
                label={schedule ? "Confirm" : "Save draft"}
                loading={confirm.isPending}
                disabled={issue !== null}
                onPress={() => {
                  // Same-frame double taps send one confirm (K11).
                  if (confirming.current || issue !== null) return;
                  confirming.current = true;
                  confirm.mutate(
                    confirmBody({
                      action: command.action,
                      text: values.text,
                      channelConnectionId: values.channelConnectionId,
                      localTime,
                      timeZone: command.timeZone,
                    }),
                  );
                }}
              />
            </>
          );
        }}
      </form.Subscribe>
    </View>
  );
}

const useStyles = createStyleHook((Colors) => ({
  card: {
    marginHorizontal: Spacing.md,
    marginBottom: Spacing.sm,
    padding: Spacing.md,
    gap: Spacing.sm,
  },
  status: { ...Typography.caption, color: Colors.muted },
  section: { gap: Spacing.sm },
  title: { ...Typography.bodyStrong, color: Colors.ink },
  body: { ...Typography.body, color: Colors.ink },
  caption: { ...Typography.caption, color: Colors.muted },
  question: {
    ...Typography.body,
    color: Colors.ink,
    fontStyle: "italic" as const,
  },
  added: {
    textDecorationLine: "underline" as const,
    color: Colors.alertForeground,
  },
  input: {
    ...Typography.body,
    color: Colors.ink,
    borderWidth: 1,
    borderColor: Colors.border,
    borderRadius: Radius.control,
    paddingHorizontal: Spacing.sm,
    paddingVertical: Spacing.xs,
    minHeight: 44,
  },
  field: { flex: 1 },
  choices: {
    flexDirection: "row" as const,
    flexWrap: "wrap" as const,
    gap: Spacing.sm,
  },
  choice: {
    borderWidth: 1,
    borderColor: Colors.border,
    borderRadius: Radius.pill,
    paddingHorizontal: Spacing.md,
    minHeight: 44,
    justifyContent: "center" as const,
  },
}));
