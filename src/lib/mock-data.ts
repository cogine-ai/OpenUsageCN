export interface Metric {
  label: string;
  value: string;
}

export interface Provider {
  id: string;
  name: string;
  metrics: Metric[];
}

export const mockProviders: Provider[] = [
  {
    id: "cursor",
    name: "Cursor",
    metrics: [
      { label: "Plan", value: "Ultra (renews Feb 14)" },
      { label: "Used", value: "$232.22/$400" },
      { label: "On-Demand Usage", value: "$0/$100" },
    ],
  },
  {
    id: "claude",
    name: "Claude",
    metrics: [
      { label: "Plan", value: "Max 5x" },
      { label: "Session", value: "5%" },
      { label: "Weekly", value: "25%" },
      { label: "Extra Usage", value: "123/1,000" },
    ],
  },
  {
    id: "codex",
    name: "Codex",
    metrics: [
      { label: "Plan", value: "Max 5x" },
      { label: "Session", value: "5%" },
      { label: "Weekly", value: "25%" },
      { label: "Code Reviews", value: "25%" },
      { label: "Extra Usage", value: "123/1,000" },
    ],
  },
];

export const APP_VERSION = "0.0.1 (dev)";
