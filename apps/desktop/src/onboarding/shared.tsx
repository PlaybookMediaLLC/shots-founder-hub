import { Trans } from "@lingui/react/macro";
import { motion, useReducedMotion } from "motion/react";
import type { ReactNode } from "react";

import {
  ArrowLeft,
  Check,
  CheckCircle,
  CircleNotch,
  Minus,
  XCircle,
} from "@anlg/ui/components/icons";
import { cn } from "@anlg/utils";

export type StepState = "done" | "skipped" | "active" | "upcoming";

export type StepListItem = {
  id: string;
  title: ReactNode;
  description: ReactNode;
  state: StepState;
};

const EASE_OUT = [0.22, 1, 0.36, 1] as const;

// Shots' numbered step list, with a ring that glides to the active step and
// connectors that fill as the user moves through.
export function OnboardingStepList({ steps }: { steps: StepListItem[] }) {
  const reduceMotion = useReducedMotion();

  return (
    <ol className="flex flex-col">
      {steps.map((step, index) => {
        const next = steps[index + 1];
        const filled = step.state === "done" || step.state === "active";
        return (
          <li
            key={step.id}
            className="relative flex gap-3 pb-6 last:pb-0"
            aria-current={step.state === "active" ? "step" : undefined}
          >
            {next ? (
              <span
                aria-hidden
                className={cn([
                  "absolute top-10 bottom-1 left-4 w-px -translate-x-1/2 transition-colors duration-500",
                  next.state === "upcoming" ? "bg-border" : "bg-foreground/50",
                ])}
              />
            ) : null}
            <span aria-hidden className="relative size-8 shrink-0">
              {step.state === "active" ? (
                <motion.span
                  layoutId="onboarding-active-step"
                  className="rounded-pill ring-foreground/15 absolute -inset-1 ring-4"
                  transition={
                    reduceMotion
                      ? { duration: 0 }
                      : { type: "spring", bounce: 0.2, duration: 0.5 }
                  }
                />
              ) : null}
              <span
                className={cn([
                  "rounded-pill relative grid size-8 place-items-center text-xs font-medium transition-colors duration-300",
                  filled
                    ? "bg-foreground text-background"
                    : "border-border bg-popover text-muted-foreground border",
                ])}
              >
                {step.state === "done" ? (
                  <motion.span
                    initial={reduceMotion ? false : { scale: 0.4, opacity: 0 }}
                    animate={{ scale: 1, opacity: 1 }}
                    transition={{ type: "spring", bounce: 0.5, duration: 0.45 }}
                  >
                    <Check className="size-3.5" weight="bold" />
                  </motion.span>
                ) : step.state === "skipped" ? (
                  <Minus className="size-3.5" weight="bold" />
                ) : (
                  index + 1
                )}
              </span>
            </span>
            <span className="min-w-0 pt-1">
              <span
                className={cn([
                  "block text-sm font-medium transition-colors duration-300",
                  step.state === "active"
                    ? "text-foreground"
                    : step.state === "upcoming"
                      ? "text-muted-foreground"
                      : "text-foreground/80",
                ])}
              >
                {step.title}
                <span className="sr-only">
                  {step.state === "done" ? (
                    <Trans> (done)</Trans>
                  ) : step.state === "skipped" ? (
                    <Trans> (skipped)</Trans>
                  ) : step.state === "active" ? (
                    <Trans> (current step)</Trans>
                  ) : null}
                </span>
              </span>
              <span className="text-muted-foreground mt-0.5 block text-xs">
                {step.description}
              </span>
            </span>
          </li>
        );
      })}
    </ol>
  );
}

// Narrow windows hide the step list, so show Shots' segmented progress instead.
export function OnboardingStepBars({
  steps,
  className,
}: {
  steps: StepListItem[];
  className?: string;
}) {
  return (
    <div aria-hidden className={cn(["flex gap-1.5 px-4 pt-4", className])}>
      {steps.map((step) => (
        <span
          key={step.id}
          className={cn([
            "rounded-pill h-0.5 flex-1 transition-colors duration-500",
            step.state === "upcoming" ? "bg-border" : "bg-foreground",
          ])}
        />
      ))}
    </div>
  );
}

export function OnboardingStepPanel({
  icon,
  iconTile = true,
  title,
  lead,
  onBack,
  onSkip,
  children,
}: {
  icon?: ReactNode;
  iconTile?: boolean;
  title: ReactNode;
  lead?: ReactNode;
  onBack?: () => void;
  onSkip?: () => void;
  children: ReactNode;
}) {
  const reduceMotion = useReducedMotion();

  return (
    <motion.div
      className="relative flex min-h-0 flex-1 flex-col"
      initial={
        reduceMotion
          ? { opacity: 0 }
          : { opacity: 0, y: 14, filter: "blur(6px)" }
      }
      animate={{ opacity: 1, y: 0, filter: "blur(0px)" }}
      exit={
        reduceMotion
          ? { opacity: 0 }
          : { opacity: 0, y: -8, filter: "blur(4px)" }
      }
      transition={{ duration: 0.32, ease: EASE_OUT }}
    >
      <div className="flex min-h-0 flex-1 flex-col overflow-y-auto">
        <div className="mx-auto flex w-full max-w-[480px] flex-1 flex-col justify-center gap-8 px-6 py-12">
          <div className="flex flex-col gap-5">
            {icon ? (
              iconTile ? (
                <span className="border-border bg-background text-foreground grid size-11 place-items-center rounded-xl border shadow-xs">
                  {icon}
                </span>
              ) : (
                icon
              )
            ) : null}
            <div>
              <h1 className="text-foreground text-2xl font-medium tracking-[-0.02em]">
                {title}
              </h1>
              {lead ? (
                <p className="text-muted-foreground mt-2 text-sm leading-relaxed">
                  {lead}
                </p>
              ) : null}
            </div>
          </div>
          {children}
        </div>
      </div>
      {onBack || onSkip ? (
        <div className="border-border/60 flex shrink-0 items-center justify-between gap-4 border-t px-4 py-3">
          {onBack ? (
            <OnboardingButton
              variant="ghost"
              onClick={onBack}
              className="-ml-1 h-8 px-2"
            >
              <ArrowLeft className="size-3.5" />
              <Trans>Back</Trans>
            </OnboardingButton>
          ) : (
            <span />
          )}
          {onSkip ? (
            <OnboardingButton
              variant="ghost"
              onClick={onSkip}
              className="h-8 px-2"
            >
              <Trans>Skip for now</Trans>
            </OnboardingButton>
          ) : null}
        </div>
      ) : null}
    </motion.div>
  );
}

// The finish line: a check that springs in with a soft pulse.
export function OnboardingSuccessMark() {
  const reduceMotion = useReducedMotion();

  return (
    <span aria-hidden className="relative grid size-11 place-items-center">
      {reduceMotion ? null : (
        <motion.span
          className="rounded-pill bg-foreground/25 absolute inset-0"
          initial={{ scale: 1, opacity: 0.6 }}
          animate={{ scale: 2, opacity: 0 }}
          transition={{
            duration: 1.2,
            ease: "easeOut",
            delay: 0.25,
            repeat: 1,
            repeatDelay: 0.3,
          }}
        />
      )}
      <motion.span
        className="rounded-pill bg-foreground text-background relative grid size-11 place-items-center"
        initial={reduceMotion ? false : { scale: 0.5, opacity: 0 }}
        animate={{ scale: 1, opacity: 1 }}
        transition={{ type: "spring", bounce: 0.45, duration: 0.6, delay: 0.1 }}
      >
        <Check className="size-5" weight="bold" />
      </motion.span>
    </span>
  );
}

export function OnboardingButton({
  variant = "primary",
  className,
  ...props
}: {
  variant?: "primary" | "secondary" | "ghost";
} & React.ButtonHTMLAttributes<HTMLButtonElement>) {
  return (
    <button
      {...props}
      className={cn([
        "inline-flex h-10 w-fit items-center justify-center gap-2 rounded-lg px-4 text-sm font-medium transition-all duration-200 active:scale-[0.98] disabled:pointer-events-none disabled:opacity-60",
        variant === "primary" &&
          "bg-primary text-primary-foreground hover:bg-primary/90",
        variant === "secondary" &&
          "border-border text-foreground hover:bg-accent border bg-transparent",
        variant === "ghost" &&
          "text-muted-foreground hover:text-foreground hover:bg-accent",
        className,
      ])}
    />
  );
}

export function StepRow({
  status,
  label,
}: {
  status: "done" | "active" | "failed";
  label: ReactNode;
}) {
  return (
    <div className="flex items-center gap-2 text-sm">
      {status === "done" && <CheckCircle className="size-4 text-emerald-600" />}
      {status === "active" && (
        <CircleNotch className="text-muted-foreground size-4 animate-spin" />
      )}
      {status === "failed" && <XCircle className="size-4 text-red-400" />}
      <span
        className={
          status === "failed" ? "text-red-500" : "text-muted-foreground"
        }
      >
        {label}
      </span>
    </div>
  );
}
