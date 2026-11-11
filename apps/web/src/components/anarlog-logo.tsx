import { ANARLOG_WORDMARK } from "@/lib/brand-assets";

export function AnarlogLogo({
  className,
  compact,
}: {
  className?: string;
  compact?: boolean;
}) {
  return (
    <svg
      viewBox="0 0 620 100"
      role="img"
      aria-label="Shots Founder Hub"
      width={620}
      height={100}
      fill="currentColor"
      className={className}
      data-compact={compact ? "true" : undefined}
    >
      <svg x="0" y="6" width="88" height="88" viewBox="100 100 440 440">
        <path d={ANARLOG_WORDMARK.path} />
      </svg>
      <text
        x="102"
        y="65"
        fontFamily="Arial, sans-serif"
        fontSize="46"
        fontWeight="600"
      >
        Shots Founder Hub
      </text>
    </svg>
  );
}
