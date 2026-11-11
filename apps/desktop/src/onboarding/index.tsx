import { Trans, useLingui } from "@lingui/react/macro";
import { useQueryClient } from "@tanstack/react-query";
import { platform } from "@tauri-apps/plugin-os";
import { AnimatePresence } from "motion/react";
import { type ReactNode, useCallback, useEffect, useState } from "react";

import {
  CalendarBlank,
  ClockCounterClockwise,
  Microphone,
  User,
} from "@anlg/ui/components/icons";

import { LoginSection } from "./account";
import { CalendarSection } from "./calendar";
import {
  getInitialStep,
  getNextStep,
  getOnboardingSteps,
  getPrevStep,
  type OnboardingStep,
} from "./config";
import { FinalDescription, FinalSection } from "./final";
import { ImportSection } from "./imports";
import { PermissionsSection } from "./permissions";
import {
  OnboardingStepBars,
  OnboardingStepList,
  OnboardingStepPanel,
  OnboardingSuccessMark,
  type StepListItem,
} from "./shared";

import { trackAnalyticsEvent } from "~/analytics";
import { useAuth } from "~/auth";
import { StandaloneWindowShell } from "~/shared/window-shell";
import { type Tab, useTabs } from "~/store/zustand/tabs";

export function TabContentOnboarding({
  tab: _tab,
}: {
  tab: Extract<Tab, { type: "onboarding" }>;
}) {
  const openCurrent = useTabs((state) => state.openCurrent);

  const handleFinish = useCallback(
    (sessionId: string) => {
      openCurrent({ type: "sessions", id: sessionId });
    },
    [openCurrent],
  );

  return <OnboardingScreenContent onFinish={handleFinish} />;
}

export function StandaloneOnboardingScreen({
  onFinish,
}: {
  onFinish: (sessionId: string) => void;
}) {
  return (
    <StandaloneWindowShell>
      <OnboardingScreenContent onFinish={onFinish} />
    </StandaloneWindowShell>
  );
}

type StepView = {
  icon: ReactNode;
  iconTile?: boolean;
  title: ReactNode;
  lead?: ReactNode;
  skippable: boolean;
  body: ReactNode;
};

// Mirrors the Shots onboarding shell: the step list on the window, the current
// step in a card panel beside it.
function OnboardingScreenContent({
  onFinish,
}: {
  onFinish: (sessionId: string) => void;
}) {
  const { t } = useLingui();
  const queryClient = useQueryClient();
  const auth = useAuth();
  const [currentStep, setCurrentStep] = useState(getInitialStep);
  const [skipped, setSkipped] = useState<ReadonlySet<OnboardingStep>>(
    () => new Set(),
  );
  const currentPlatform = platform();
  const steps = getOnboardingSteps();

  const leaveStep = useCallback((from: OnboardingStep, wasSkipped: boolean) => {
    setSkipped((prev) => {
      const next = new Set(prev);
      if (wasSkipped) next.add(from);
      else next.delete(from);
      return next;
    });
    const next = getNextStep(from);
    if (next) setCurrentStep(next);
  }, []);

  const goNext = useCallback(() => {
    trackAnalyticsEvent("onboarding_step_completed", {
      step: currentStep,
      platform: currentPlatform,
    });
    leaveStep(currentStep, false);
  }, [currentPlatform, currentStep, leaveStep]);

  const skipCurrentStep = useCallback(() => {
    if (currentStep === "login") {
      trackAnalyticsEvent("onboarding_login_skipped");
    }
    trackAnalyticsEvent("onboarding_step_skipped", {
      step: currentStep,
      platform: currentPlatform,
    });
    leaveStep(currentStep, true);
  }, [currentPlatform, currentStep, leaveStep]);

  const goBack = useCallback(() => {
    const prev = getPrevStep(currentStep);
    if (prev) setCurrentStep(prev);
  }, [currentStep]);

  const handleCalendarSignIn = useCallback(() => {
    setCurrentStep("login");
    void auth.signIn();
  }, [auth]);

  useEffect(() => {
    trackAnalyticsEvent("onboarding_step_viewed", {
      step: currentStep,
      platform: currentPlatform,
    });
  }, [currentPlatform, currentStep]);

  const handleFinish = useCallback(
    (sessionId: string) => {
      trackAnalyticsEvent("onboarding_step_completed", {
        step: "final",
        platform: currentPlatform,
      });
      void queryClient.invalidateQueries({ queryKey: ["onboarding-needed"] });
      onFinish(sessionId);
    },
    [currentPlatform, onFinish, queryClient],
  );

  const currentIndex = steps.indexOf(currentStep);
  const stepList: StepListItem[] = steps.map((step, index) => {
    const state =
      index === currentIndex
        ? "active"
        : index > currentIndex
          ? "upcoming"
          : skipped.has(step) && !(step === "login" && auth.session)
            ? "skipped"
            : "done";
    const label = {
      permissions: {
        title: t`Allow access`,
        description: t`Microphone and system audio`,
      },
      login: {
        title: t`Create your account`,
        description: auth.session
          ? t`Signed in`
          : t`Free Pro with a work email`,
      },
      calendar: {
        title: t`Connect your calendar`,
        description: t`Reminders before meetings`,
      },
      imports: {
        title: t`Import meeting history`,
        description: t`From apps you already use`,
      },
      final: {
        title: t`All set`,
        description: t`Open your first note`,
      },
    }[step];
    return {
      id: step,
      title: label.title,
      description: state === "skipped" ? t`Skipped` : label.description,
      state,
    };
  });

  const views: Record<OnboardingStep, StepView> = {
    permissions: {
      icon: <Microphone className="size-5" />,
      title: <Trans>Allow access</Trans>,
      lead: (
        <Trans>
          Shots Founder Hub uses your microphone and system audio to transcribe
          meetings, and Accessibility to read meeting controls and visible chat.
        </Trans>
      ),
      // Production requires these; dev builds can step past them for testing.
      skippable: import.meta.env.DEV,
      body: <PermissionsSection onContinue={goNext} />,
    },
    login: {
      icon: <User className="size-5" />,
      title: <Trans>Create your account</Trans>,
      lead: (
        <Trans>
          Sign in with your Shots account. A work email unlocks a free Pro
          trial.
        </Trans>
      ),
      skippable: true,
      body: <LoginSection onContinue={goNext} />,
    },
    calendar: {
      icon: <CalendarBlank className="size-5" />,
      title: <Trans>Connect your calendar</Trans>,
      lead: (
        <Trans>Sync your calendar to get a reminder before each meeting.</Trans>
      ),
      skippable: true,
      body: (
        <CalendarSection onContinue={goNext} onSignIn={handleCalendarSignIn} />
      ),
    },
    imports: {
      icon: <ClockCounterClockwise className="size-5" />,
      title: <Trans>Bring your meeting history</Trans>,
      lead: (
        <Trans>
          Import notes and transcripts from the meeting apps you already use.
        </Trans>
      ),
      skippable: true,
      body: <ImportSection onContinue={goNext} onSkip={skipCurrentStep} />,
    },
    final: {
      icon: <OnboardingSuccessMark />,
      iconTile: false,
      title: <Trans>You're all set</Trans>,
      lead: <Trans>Open Shots Founder Hub to see your welcome note.</Trans>,
      skippable: false,
      body: (
        <div className="flex flex-col gap-6">
          <FinalSection onContinue={handleFinish} />
          <div className="text-muted-foreground text-sm">
            <FinalDescription />
          </div>
        </div>
      ),
    },
  };
  const view = views[currentStep];

  const email = auth.session?.user.email;

  // Below lg the frame fills the window; on large screens it floats at a
  // comfortable size, as the Shots onboarding frame does in a browser.
  return (
    <div className="bg-background text-foreground flex h-full min-h-0 items-center justify-center lg:p-6">
      <div className="bg-popover lg:border-border flex size-full min-h-0 overflow-hidden lg:max-h-[760px] lg:max-w-[1120px] lg:rounded-2xl lg:border lg:p-2 lg:shadow-2xl">
        <aside
          data-tauri-drag-region
          className="hidden w-64 shrink-0 flex-col justify-between px-5 pt-14 pb-5 md:flex lg:pt-8"
        >
          <div className="flex flex-col gap-10">
            <div className="flex items-center gap-2.5">
              <img
                src="/assets/anarlog-icon.png"
                alt=""
                className="size-7 rounded-lg"
              />
              <span className="text-sm font-semibold tracking-tight">
                Shots Founder Hub
              </span>
            </div>
            <OnboardingStepList steps={stepList} />
          </div>
          {email ? (
            <div className="text-muted-foreground truncate text-xs">
              <Trans>
                Signed in as <span className="text-foreground/80">{email}</span>
              </Trans>
            </div>
          ) : null}
        </aside>
        <section className="bg-card border-border relative m-2 flex min-w-0 flex-1 flex-col overflow-hidden rounded-xl border md:ml-0 lg:m-0">
          <div
            aria-hidden
            className="pointer-events-none absolute inset-x-0 top-0 h-72 bg-[radial-gradient(55%_100%_at_50%_0%,hsl(var(--foreground)/0.06),transparent_70%)]"
          />
          <OnboardingStepBars steps={stepList} className="md:hidden" />
          <AnimatePresence mode="wait" initial={false}>
            <OnboardingStepPanel
              key={currentStep}
              icon={view.icon}
              iconTile={view.iconTile}
              title={view.title}
              lead={view.lead}
              onBack={currentIndex > 0 ? goBack : undefined}
              onSkip={view.skippable ? skipCurrentStep : undefined}
            >
              {view.body}
            </OnboardingStepPanel>
          </AnimatePresence>
        </section>
      </div>
    </div>
  );
}
