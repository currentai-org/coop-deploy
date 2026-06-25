# coop/ — vanilla Coop stack + the app↔Coop bootstrap

This folder runs **stock Coop** locally in Docker and wires the **detector-agnostic app↔Coop
contract** the chat seam (`src/lib/server/moderation.ts`) talks to. No custom plugin, no derived
image: content + child-safety are the **user's Zentropi rules in Coop**; prompt-injection is screened
**in-app** (deberta). Zero-dep bootstrap (Node ≥ 20).

```bash
# from chat-svelte/
npm run coop:up            # docker compose -f coop/docker-compose.yml up -d  (stock images, no build)

# capture the seed creds (printed once, on the first seed run) into coop/.coop-secrets.env (gitignored):
#   COOP_URL, COOP_API_KEY, COOP_ADMIN_EMAIL, COOP_ADMIN_PASSWORD, COOP_ORG_ID
docker compose -f coop/docker-compose.yml logs seed

npm run coop:bootstrap     # node coop/bootstrap.mjs  → app contract + async plumbing + /content proof
npm run coop:verify-mrt    # node coop/verify-mrt.mjs → async-plane proof (needs the user's child rule, below)
```

### What bootstrap creates (detector-agnostic)

1. **login** (admin email/password) → session cookie.
2. **ensure `ChatMessage` item type** — STRING fields `text` + `threadId`, plus an `author`
   `RELATED_ITEM` field with the `creatorId` role (so a strike-threshold MRT enqueue can resolve the
   author). `displayName` role → `text`.
3. **ensure `chat-block` + `chat-block-child` + `strike-escalation`** CUSTOM_ACTIONs → callbackUrl
   `http://audit-sink:9090/<name>`.
4. **ensure a LIVE rule** `guardrails-regex-canary` — built-in `TEXT_MATCHING_CONTAINS_TEXT` on
   `text` matching a canary token, firing `chat-block`. This is the ONLY rule bootstrap authors; it
   proves the `/content` sync contract with no model.
5. **wire the async plane** — `applyUserStrikes:true` on `chat-block-child`, a `child-safety-review`
   MRT queue, a strike **threshold** (3 → `strike-escalation` webhook + `ENQUEUE_AUTHOR_TO_MRT`), and
   a catch-all author routing rule.
6. **verify** — `verifyOrg` reads the config back and fails loud on drift; then `POST /api/v1/content`
   (`sync:true`): a banned-token turn returns `actionsTriggered:["chat-block"]`; a clean turn `[]`.

Bootstrap does **NOT** create any content/child rule or strike policy — those are yours to author
in Coop (see below).

### Your Coop setup (the user-owned part)

After bootstrap, in the Coop dashboard:

- Add **Zentropi creds + labelers**, then author your **content** + **child** rules (map CoPE scores
  → `chat-block` / `chat-block-child`).
- For **strikes** to accrue: attach a policy with **`userStrikeCount > 0`** to your child rule.
  Without it, `applyUserStrikeFromPublishedActions` bails (no strikes counted).
- For child-safety to be truly **fail-closed on a Zentropi outage**: add a companion child rule using
  the Zentropi child signal's **`IS_UNAVAILABLE`** condition → `chat-block-child`. (Native Zentropi
  *throws* on a signal outage; Coop then returns `200 []` and the app sees a clean verdict — so
  without this companion rule, child is fail-OPEN on a Zentropi-only outage. See
  [`../docs/v6-async-plane.md`](../docs/v6-async-plane.md).)

### Zentropi field-name patch (`patches/zentropiUtils.js`)

The pinned stock `coop-server` POSTs the Zentropi request field `labeler_version_id`, but the
Zentropi `/v1/label` API expects `labeler_id`. `docker-compose.yml` bind-mounts `patches/zentropiUtils.js`
(read-only) over the stock signal file to fix that — keeping the image stock (no rebuild). Drop the
mount once a stock image ships the fix.

### Coop quirks worked around (verified in-tree)

- **Item-type mutation can't return its id** — Coop spreads the type instead of `{data}`, so the
  success `data` field is always null. We resolve ids via `org(id){itemTypes/actions/rules}` by name
  (which also makes the script idempotent).
- **Duplicate create 500s** (unique constraint, not a graceful union error), so we **look up first**
  and create only what's missing.
- `ItemType`/`Action`/`Rule` are **interfaces** — lookups use concrete inline fragments
  (`ContentItemType` / `CustomAction` / `ContentRule`).
- The boolean text-matching signal needs **no comparator/threshold** — its boolean score is the
  condition result.

### Files

- `docker-compose.yml` — the stock Coop stack (postgres/redis/scylla/clickhouse/migrations/seed/server/client/audit-sink).
- `coop.env` — curated env for the stack.
- `bootstrap.mjs` — the app-contract + async-plane bootstrap (idempotent; ids in `.coop-ids.json`).
- `verify-mrt.mjs` — async-plane (strike → MRT) proof; depends on your live child rule + strike policy.
- `patches/zentropiUtils.js` — the one-file Zentropi field-name fix (bind-mounted).
- `audit-sink/` — instant-200 callback target for the CUSTOM_ACTION webhooks.
- `.coop-secrets.env` / `.coop-ids.json` — gitignored local creds + id cache.
