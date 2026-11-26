/** A few task templates. Cheap: only listed names until a client fetches one. */
export const PROMPTS = [
  {
    name: "catch_up",
    title: "Catch up on home timeline and notifications",
    description: "Summarize recent home timeline posts and unread notifications.",
    arguments: [{ name: "limit", description: "Posts to read (default 20)", required: false }],
    render: (a: Record<string, string>) =>
      `Use mastodon_api_call with id "timelines.home" (args {"limit":${Number(a.limit) || 20}}, select ["id","created_at","account.acct","content","reblog.account.acct","reblog.content"]) and id "grouped_notifications.get-grouped" (args {"limit":20}). Summarize the main topics, notable posts (with ids), and anything that needs a reply.`,
  },
  {
    name: "moderation_queue",
    title: "Review open moderation reports",
    description: "Triage unresolved reports (needs admin:read:reports and a staff role).",
    arguments: [],
    render: () =>
      `Call mastodon_api_call {"id":"admin.reports.get","args":{"resolved":false,"limit":20}}. For each report give: id, target account, category, rule violations, comment, and the reported statuses (fetch with admin.reports.get-one if needed). Suggest an action (none / sensitive / silence / suspend / dismiss) with reasoning. Do NOT take any action without explicit confirmation.`,
  },
  {
    name: "compose_post",
    title: "Draft and publish a post",
    description: "Draft a post, confirm with the user, then publish.",
    arguments: [
      { name: "topic", description: "What to post about", required: true },
      { name: "visibility", description: "public | unlisted | private | direct", required: false },
    ],
    render: (a: Record<string, string>) =>
      `Draft a Mastodon post about: ${a.topic ?? "(ask the user)"}. Respect the instance character limit (mastodon_api_call {"id":"instance.v2","select":["configuration.statuses"]}). Show the draft and ask for confirmation, then publish with {"id":"statuses.create","args":{"status":"…","visibility":"${a.visibility ?? "public"}"},"idempotency_key":"<uuid>"}.`,
  },
];
