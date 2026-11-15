import { Trans } from "@lingui/react/macro";

import { OnboardingButton, StepRow } from "../shared";

export function AfterLogin({ onContinue }: { onContinue: () => void }) {
  return (
    <div className="flex flex-col items-start gap-4">
      <StepRow status="done" label={<Trans>Signed in</Trans>} />
      <OnboardingButton onClick={onContinue}>
        <Trans>Continue</Trans>
      </OnboardingButton>
    </div>
  );
}
