import { MeetingImportScreen } from "~/imports/screen";

export function ImportSection({
  onContinue,
  onSkip,
}: {
  onContinue: () => void;
  onSkip: () => void;
}) {
  return (
    <MeetingImportScreen
      compact
      onContinue={onContinue}
      onNoSourcesDetected={onSkip}
    />
  );
}
