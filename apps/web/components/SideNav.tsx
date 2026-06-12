"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useI18n } from "./I18nProvider";

interface NavItem {
  href: string;
  labelKey: string;
  exact?: boolean;
}

interface NavGroup {
  labelKey: string;
  items: NavItem[];
}

const groups: NavGroup[] = [
  {
    labelKey: "nav.group.overview",
    items: [{ href: "/", labelKey: "nav.home", exact: true }],
  },
  {
    labelKey: "nav.group.ops",
    items: [
      { href: "/accounts", labelKey: "nav.accounts" },
      { href: "/reports/daily", labelKey: "nav.dailyReport" },
      { href: "/budget", labelKey: "nav.budget" },
      { href: "/guards", labelKey: "nav.guards" },
      { href: "/plans", labelKey: "nav.plans" },
      { href: "/campaigns", labelKey: "nav.campaigns" },
    ],
  },
  {
    labelKey: "nav.group.improve",
    items: [
      { href: "/improvements", labelKey: "nav.improvements" },
      { href: "/experiments", labelKey: "nav.experiments" },
      { href: "/creatives", labelKey: "nav.creatives" },
      { href: "/creatives/submit", labelKey: "nav.creativeSubmit" },
    ],
  },
  {
    labelKey: "nav.group.automation",
    items: [
      { href: "/approvals", labelKey: "nav.approvals" },
      { href: "/cron", labelKey: "nav.cron", exact: true },
      { href: "/cron/runs", labelKey: "nav.cronRuns" },
      { href: "/cron/audit", labelKey: "nav.audit" },
      { href: "/github", labelKey: "nav.github" },
    ],
  },
  {
    labelKey: "nav.group.settings",
    items: [{ href: "/setup", labelKey: "nav.setup" }],
  },
];

export function SideNav() {
  const pathname = usePathname() ?? "/";
  const { t } = useI18n();
  return (
    <nav className="side-nav" aria-label="primary">
      {groups.map((group) => (
        <div className="side-nav__group" key={group.labelKey}>
          <div className="side-nav__group-label">{t(group.labelKey)}</div>
          {group.items.map((item) => {
            const active = item.exact ? pathname === item.href : pathname.startsWith(item.href);
            return (
              <Link
                key={item.href}
                href={item.href}
                className="side-nav__link"
                data-active={active ? "true" : "false"}
              >
                {t(item.labelKey)}
              </Link>
            );
          })}
        </div>
      ))}
    </nav>
  );
}
