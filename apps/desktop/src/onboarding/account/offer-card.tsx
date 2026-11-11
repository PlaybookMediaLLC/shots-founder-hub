import { motion, useReducedMotion } from "motion/react";
import type { ReactNode } from "react";

import { cn } from "@anlg/utils";

const NUMBER_CLASS =
  "text-[40px] leading-none font-semibold tracking-[-0.02em] text-foreground";
const EASE = [0.22, 1, 0.36, 1] as const;

function DayCount({ days, from }: { days: number; from?: number }) {
  const reduceMotion = useReducedMotion();
  const animate = from !== undefined && from !== days && !reduceMotion;

  return (
    <div className="flex w-14 shrink-0 flex-col items-center">
      <div className="relative flex h-10 w-full items-center justify-center">
        {animate ? (
          <>
            <motion.span
              aria-hidden="true"
              className={cn([NUMBER_CLASS, "absolute"])}
              animate={{ opacity: 0, filter: "blur(4px)" }}
              transition={{ delay: 1.1, duration: 0.35, ease: EASE }}
            >
              {from}
              <motion.span
                className="bg-foreground absolute top-1/2 -right-1 -left-1 h-[2.5px] origin-left rounded-full"
                initial={{ scaleX: 0 }}
                animate={{ scaleX: 1 }}
                transition={{ delay: 0.45, duration: 0.3, ease: "easeOut" }}
              />
            </motion.span>
            <motion.span
              className={NUMBER_CLASS}
              initial={{ opacity: 0, filter: "blur(4px)" }}
              animate={{ opacity: 1, filter: "blur(0px)" }}
              transition={{ delay: 1.25, duration: 0.35, ease: EASE }}
            >
              {days}
            </motion.span>
          </>
        ) : (
          <span className={NUMBER_CLASS}>{days}</span>
        )}
      </div>
      <span className="text-muted-foreground mt-1 pl-[0.22em] text-[10px] font-semibold tracking-[0.22em] uppercase">
        days
      </span>
    </div>
  );
}

export function TrialOfferCard({
  days,
  fromDays,
  icon,
  title,
  subtitle,
}: {
  days: number;
  fromDays?: number;
  icon?: ReactNode;
  title: ReactNode;
  subtitle?: ReactNode;
}) {
  return (
    <div
      className={cn([
        "flex w-full max-w-[400px] items-center gap-5 rounded-xl py-4 pr-6 pl-5",
        "border-border bg-card/85 border shadow-md backdrop-blur-md",
      ])}
    >
      <DayCount days={days} from={fromDays} />
      <div className="bg-border h-11 w-px shrink-0" />
      <div className="flex min-w-0 flex-col gap-0.5">
        <span className="text-foreground flex items-center gap-1.5 text-[15px] font-semibold tracking-[-0.01em]">
          {icon}
          {title}
        </span>
        {subtitle && (
          <span className="text-muted-foreground truncate text-[13px]">
            {subtitle}
          </span>
        )}
      </div>
    </div>
  );
}
