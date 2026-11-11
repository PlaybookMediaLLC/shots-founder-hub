import { Row, Spacer } from "@expo/ui";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { AccessibilityInfo } from "react-native";

import { useAuth } from "@/auth/context";
import { confirmDestructive } from "@/lib/confirm";
import {
  SettingsError,
  SettingsPage,
  SettingsRow,
} from "@/settings/components";
import { FieldGroup } from "@/settings/field-group";
import { Button, Picker, Switch, Text } from "@/settings/fields";

import { isVoiceNoteUnsent } from "./model";
import {
  fetchShotsWorkspaces,
  readShotsVoiceSettings,
  requestShotsVoiceSync,
  updateShotsVoiceMember,
} from "./runner";
import {
  retryShotsVoiceNotes,
  setShotsVoicePrefs,
  useShotsVoice,
  type ShotsVoicePrefs,
} from "./store";

export function ShotsVoiceSettings() {
  const auth = useAuth();
  const voice = useShotsVoice();
  const queryClient = useQueryClient();
  const accountId = auth.session?.user.id ?? null;
  const accessToken = auth.session?.access_token ?? null;
  const workspaceId = voice.ready ? voice.prefs.workspaceId : null;
  const workspaces = useQuery({
    queryKey: ["shots-voice-workspaces", accountId],
    queryFn: ({ signal }) => fetchShotsWorkspaces(accessToken!, signal),
    enabled: Boolean(accountId && accessToken),
  });
  const settingsKey = ["shots-voice-settings", accountId, workspaceId];
  const settings = useQuery({
    queryKey: settingsKey,
    queryFn: () => readShotsVoiceSettings(accountId!, workspaceId!),
    enabled: Boolean(accountId && workspaceId),
  });
  const prefs = useMutation({
    mutationFn: (patch: Partial<ShotsVoicePrefs>) => setShotsVoicePrefs(patch),
    onSuccess: () => requestShotsVoiceSync(),
  });
  const member = useMutation({
    mutationFn: (body: {
      remoteTextConsent?: boolean;
      voiceCommands?: boolean;
    }) => updateShotsVoiceMember(accountId!, workspaceId!, body),
    onSuccess: (data) => {
      queryClient.setQueryData(settingsKey, data);
      AccessibilityInfo.announceForAccessibility("Saved in Shots.");
    },
  });
  const retry = useMutation({
    mutationFn: retryShotsVoiceNotes,
    onSuccess: () => requestShotsVoiceSync(),
  });

  const chooseWorkspace = async (id: string) => {
    const chosen = workspaces.data?.find((workspace) => workspace.id === id);
    if (!chosen || chosen.id === workspaceId) return;
    const unsent = voice.notes.filter(isVoiceNoteUnsent).length;
    if (
      unsent > 0 &&
      !(await confirmDestructive(
        `Switch to ${chosen.name}?`,
        "Switch",
        `${unsent} ${unsent === 1 ? "note has" : "notes have"} not been sent to ${voice.prefs.workspaceName ?? "the current workspace"} yet. They stay on this phone and are sent when you switch back.`,
      ))
    )
      return;
    prefs.mutate({ workspaceId: chosen.id, workspaceName: chosen.name });
  };

  const data = settings.data;
  const audioAvailable = Boolean(
    data?.workspace.audioUpload && data.switches.audioUpload,
  );
  const consented = Boolean(data?.member.remoteTextConsentAt);
  const commandsAvailable = Boolean(
    data?.workspace.voiceCommands && data.switches.parse,
  );
  const waiting = voice.notes.filter(isVoiceNoteUnsent).length;
  const deleted = voice.notes.filter((note) => note.deletedRemote).length;
  const refused = voice.notes.filter((note) => note.failed || note.blocked);

  return (
    <SettingsPage title="Shots">
      <FieldGroup.Section title="Workspace">
        {workspaces.data && workspaces.data.length > 0 ? (
          <Row alignment="center">
            <Text>Send notes to</Text>
            <Spacer flexible />
            <Picker
              selectedValue={workspaceId ?? ""}
              onValueChange={(value) => void chooseWorkspace(value)}
              enabled={!prefs.isPending}
            >
              {[
                ...(workspaceId
                  ? workspaces.data.some((item) => item.id === workspaceId)
                    ? []
                    : // Removed from it: keep it selectable so its queue stays visible (S10).
                      [
                        {
                          id: workspaceId,
                          name:
                            voice.prefs.workspaceName ?? "Previous workspace",
                        },
                      ]
                  : [{ id: "", name: "Choose a workspace" }]),
                ...workspaces.data,
              ].map((workspace) => (
                <Picker.Item
                  key={workspace.id}
                  value={workspace.id}
                  label={workspace.name}
                />
              ))}
            </Picker>
          </Row>
        ) : (
          <Text>
            {workspaces.isPending
              ? "Loading your Shots workspaces…"
              : workspaces.error
                ? "Could not load your Shots workspaces."
                : "This account is not in a Shots workspace yet."}
          </Text>
        )}
        {workspaces.error && (
          <Button label="Try again" onPress={() => void workspaces.refetch()} />
        )}
        <FieldGroup.SectionFooter>
          <Text>
            Recordings are sent to this workspace, which is shown while you
            record. Your notes in Shots are visible only to you.
          </Text>
        </FieldGroup.SectionFooter>
      </FieldGroup.Section>

      <FieldGroup.Section title="Sending">
        <Switch
          label="Send new recordings to Shots"
          value={voice.prefs.sendNew}
          disabled={!workspaceId || prefs.isPending}
          onValueChange={(sendNew) => prefs.mutate({ sendNew })}
        />
        <Switch
          label="Upload audio"
          value={voice.prefs.uploadAudio && audioAvailable}
          disabled={!workspaceId || !audioAvailable || prefs.isPending}
          onValueChange={(uploadAudio) => prefs.mutate({ uploadAudio })}
        />
        <FieldGroup.SectionFooter>
          <Text>
            {`Recordings are transcribed by the provider you chose in Transcription & summaries, and that transcript is sent to Shots. If it gives none, this phone transcribes the note on device, and the note is summarized like any other by your summary provider. Only the transcript is sent unless you turn on audio upload${audioAvailable ? "" : ", which this workspace does not allow"}. You can also send any recorded note from its menu.`}
          </Text>
        </FieldGroup.SectionFooter>
        <SettingsError error={prefs.error} />
      </FieldGroup.Section>

      {workspaceId && (
        <FieldGroup.Section title="Remote text processing">
          <Text>
            Voice commands and drafts send your transcript text to the model
            provider Shots uses, even when the audio stays on this phone.
            Nothing is sent this way until you allow it.
          </Text>
          <Switch
            label="Allow remote text processing"
            value={consented}
            disabled={!data || member.isPending}
            onValueChange={(remoteTextConsent) =>
              member.mutate({ remoteTextConsent })
            }
          />
          <Switch
            label="Voice commands"
            value={Boolean(data?.member.voiceCommands)}
            disabled={
              !data || !consented || !commandsAvailable || member.isPending
            }
            onValueChange={(voiceCommands) => member.mutate({ voiceCommands })}
          />
          <FieldGroup.SectionFooter>
            <Text>
              {commandsAvailable
                ? "Say “Shots, post …” in a recording to get a card on the note. Nothing is posted until you tap Confirm. Turning off remote processing turns voice commands off."
                : "Voice commands are off in this workspace."}
            </Text>
          </FieldGroup.SectionFooter>
          {settings.error && (
            <Text>
              {settings.error instanceof Error
                ? settings.error.message
                : "Could not load Shots settings."}
            </Text>
          )}
          <SettingsError error={member.error} />
        </FieldGroup.Section>
      )}

      {workspaceId && (
        <FieldGroup.Section title="Status">
          {voice.status?.message && <Text>{voice.status.message}</Text>}
          <SettingsRow title="Waiting to send" value={String(waiting)} />
          {deleted > 0 && (
            <SettingsRow
              title="Deleted in Shots"
              value={String(deleted)}
              description="These notes stay on this phone; they are no longer sent."
            />
          )}
          {refused.map((note) => (
            <SettingsRow
              key={note.sessionId}
              title="Not sent"
              description={note.failed ?? note.blocked ?? undefined}
            />
          ))}
          <Button label="Send now" onPress={requestShotsVoiceSync} />
          {refused.length > 0 && (
            <Button
              label="Try again"
              disabled={retry.isPending}
              onPress={() => retry.mutate()}
            />
          )}
        </FieldGroup.Section>
      )}
    </SettingsPage>
  );
}
