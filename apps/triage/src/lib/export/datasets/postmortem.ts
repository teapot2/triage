import type { Incident, PostmortemActionItem } from "@/lib/investigation/schema";
import { defineDataset } from "../dataset";

// A postmortem's action items, to file as tickets. The columns are named as
// Jira's and Linear's CSV importers name their fields (title, description,
// priority, labels), so mapping them is a matter of confirming.

export type ActionItemRow = {
  item: PostmortemActionItem;
  incident: Pick<Incident, "id" | "title">;
  // The incident page's absolute address.
  url: string;
};

const kindInWords: Record<PostmortemActionItem["kind"], string> = {
  fix_this: "Fix this",
  prevent_class: "Prevent the class",
  detect_sooner: "Detect sooner",
  mitigate_faster: "Mitigate faster",
};

export const postmortemActions = defineDataset<ActionItemRow>({
  id: "postmortem-actions",
  name: "Postmortem action items",
  columns: [
    { key: "title", value: ({ item }) => item.title.trim() },
    // One plain line: a ticket body that still says where it came from once
    // it's far from the incident.
    {
      key: "description",
      value: ({ item, incident, url }) => `${kindInWords[item.kind]}, from the postmortem of "${incident.title}": ${url}`,
    },
    { key: "priority", value: ({ item }) => item.priority },
    // Two labels, semicolon-separated: one to find every postmortem item,
    // one for its kind. The kind stays in snake_case, as labels take no spaces.
    { key: "labels", value: ({ item }) => `postmortem;${item.kind}` },
    { key: "incident_id", value: ({ incident }) => incident.id },
    { key: "incident_url", value: ({ url }) => url },
    { key: "evidence_ids", value: ({ item }) => item.evidenceIds?.join(" ") },
  ],
  formats: ["csv", "json"],
});
