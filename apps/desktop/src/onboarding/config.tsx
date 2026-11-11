import { platform } from "@tauri-apps/plugin-os";

export type OnboardingStep =
  | "permissions"
  | "login"
  | "calendar"
  | "imports"
  | "final";

const STEPS_MACOS: OnboardingStep[] = [
  "permissions",
  "login",
  "calendar",
  "imports",
  "final",
];
const STEPS_OTHER: OnboardingStep[] = ["login", "calendar", "imports", "final"];

export function getOnboardingSteps(): OnboardingStep[] {
  return platform() === "macos" ? STEPS_MACOS : STEPS_OTHER;
}

export function getInitialStep(): OnboardingStep {
  return getOnboardingSteps()[0];
}

export function getNextStep(
  currentStep: OnboardingStep,
): OnboardingStep | null {
  const steps = getOnboardingSteps();
  const idx = steps.indexOf(currentStep);
  return idx < steps.length - 1 ? steps[idx + 1] : null;
}

export function getPrevStep(
  currentStep: OnboardingStep,
): OnboardingStep | null {
  const steps = getOnboardingSteps();
  const idx = steps.indexOf(currentStep);
  return idx > 0 ? steps[idx - 1] : null;
}
