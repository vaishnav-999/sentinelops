export const NAV_ITEMS = [
  { href: "/overview", label: "Overview", icon: "overview" },
  { href: "/infrastructure", label: "Infrastructure", icon: "infrastructure" },
  { href: "/incidents", label: "Incidents", icon: "incidents" },
  { href: "/auto-heal", label: "Auto-Heal", icon: "auto-heal" },
  { href: "/chaos-lab", label: "Chaos Lab", icon: "chaos-lab" },
  { href: "/logs", label: "Logs", icon: "logs" },
  { href: "/ml-insights", label: "ML Insights", icon: "ml-insights" },
  { href: "/settings", label: "Settings", icon: "settings" },
] as const;

export type NavIconId = (typeof NAV_ITEMS)[number]["icon"];
