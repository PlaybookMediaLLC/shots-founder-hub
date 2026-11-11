export const BOOK_CALL_URL =
  "mailto:team@playbookmedia.io?subject=Shots%20Founder%20Hub";
export const SECURITY_REPORT_EMAIL = "team@playbookmedia.io";
export const SECURITY_ADVISORY_URL =
  "mailto:team@playbookmedia.io?subject=Shots%20Founder%20Hub%20security%20report";
export const PROCUREMENT_EMAIL = "team@playbookmedia.io";

export const ENTERPRISE_EVENTS = {
  pageViewed: "enterprise_page_viewed",
  securityPageViewed: "security_page_viewed",
  ctaClicked: "enterprise_cta_clicked",
} as const;

export type EnterpriseCta =
  | "book_call"
  | "security"
  | "enterprise"
  | "privacy"
  | "terms"
  | "pricing"
  | "docs"
  | "dpa"
  | "security_report";

export type EnterpriseCtaLocation =
  | "hero"
  | "security_review"
  | "pilot"
  | "talk"
  | "footer"
  | "packet";

export type EnterpriseSurface = "enterprise" | "security";
