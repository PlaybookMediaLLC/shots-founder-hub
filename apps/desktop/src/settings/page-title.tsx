import type { ReactNode } from "react";

export function SettingsPageTitle({ title }: { title: ReactNode }) {
  return (
    <h2 className="text-[22px] leading-7 font-medium tracking-[-0.02em]">
      {title}
    </h2>
  );
}
