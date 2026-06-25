#!/usr/bin/env node
/**
 * Coop bootstrap for the vanilla-Coop chat-moderation pathway.
 * Idempotent-ish: created ids are saved to coop/.coop-ids.json and reused.
 *
 * This creates the DETECTOR-AGNOSTIC app↔Coop contract + the async-plane plumbing. It does
 * NOT create any content/child rule or strike policy — those are the user's to author in Coop
 * (mapping their Zentropi signals → actions, and attaching a userStrikeCount policy to their
 * child rule so strikes accrue). The only rule bootstrap authors is a regex canary that proves
 * the /content sync contract with no model.
 *
 * Steps:
 *   1. login (admin email/password) -> session cookie
 *   2. ensure ChatMessage item type (STRING fields text + threadId) + author creatorId role
 *   3. ensure chat-block + chat-block-child + strike-escalation CUSTOM_ACTIONs (-> audit-sink)
 *   4. ensure a LIVE regex/contains rule firing chat-block on a banned canary token
 *      (built-in TEXT_MATCHING_CONTAINS_TEXT — proves the contract with no model)
 *   5. wire the async plane: strikes on chat-block-child, MRT review queue, strike threshold
 *      (3 → strike-escalation webhook + enqueue-author-to-MRT), catch-all author routing rule
 *   6. verify POST /api/v1/content (sync:true): banned text -> chat-block; clean -> []
 *
 * Zero dependencies (Node >= 20, global fetch + getSetCookie).
 * Usage:  node coop/bootstrap.mjs   (reads coop/.coop-secrets.env; or `npm run coop:bootstrap`)
 */

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const IDS_FILE = join(HERE, '.coop-ids.json');
const SECRETS_FILE = join(HERE, '.coop-secrets.env');

// ── config ──────────────────────────────────────────────────────────────
const ITEM_TYPE = 'ChatMessage';
const BLOCK_ACTION = 'chat-block';
const CHILD_BLOCK_ACTION = 'chat-block-child';
const CANARY_TOKEN = 'moderation-canary-block'; // distinctive banned token for the regex proof
const RULE_NAME = 'guardrails-regex-canary';
// item 1 (MRT author enqueue): a RELATED_ITEM field carrying the creatorId role, plus a
// routing rule that sends author (User-item) MRT jobs to the child-safety-review queue.
const AUTHOR_FIELD = 'author';
const ROUTING_RULE_NAME = 'child-safety-author-routing';

// ── env / secrets ───────────────────────────────────────────────────────
function loadEnvFile(path) {
  if (!existsSync(path)) return {};
  const out = {};
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m && !line.trim().startsWith('#')) out[m[1]] = m[2];
  }
  return out;
}
const env = { ...loadEnvFile(SECRETS_FILE), ...process.env };
const COOP_URL = env.COOP_URL ?? 'http://localhost:8080';
const GQL_URL = `${COOP_URL}/api/v1/graphql`;
const CONTENT_URL = `${COOP_URL}/api/v1/content`;
const ADMIN_EMAIL = env.COOP_ADMIN_EMAIL;
const ADMIN_PASSWORD = env.COOP_ADMIN_PASSWORD;
const API_KEY = env.COOP_API_KEY;
const ORG_ID = env.COOP_ORG_ID;
// Callback target is the in-stack audit sink (instant 200), resolved over the Docker
// network from the server container. Read from the merged env (secrets file + process).
const AUDIT_BASE = env.COOP_AUDIT_BASE ?? 'http://audit-sink:9090';

if (!ADMIN_EMAIL || !ADMIN_PASSWORD || !API_KEY || !ORG_ID) {
  console.error(`Missing creds. Need COOP_ADMIN_EMAIL/PASSWORD + COOP_API_KEY + COOP_ORG_ID in ${SECRETS_FILE} or env.`);
  process.exit(2);
}

const ids = existsSync(IDS_FILE) ? JSON.parse(readFileSync(IDS_FILE, 'utf8')) : {};
function saveIds() {
  writeFileSync(IDS_FILE, JSON.stringify(ids, null, 2) + '\n');
}

let cookie = '';

async function gql(query, variables = {}) {
  const res = await fetch(GQL_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}) },
    body: JSON.stringify({ query, variables }),
  });
  const setCookie = typeof res.headers.getSetCookie === 'function' ? res.headers.getSetCookie() : [];
  if (setCookie.length) cookie = setCookie.map((c) => c.split(';')[0]).join('; ');
  const text = await res.text();
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    throw new Error(`GraphQL non-JSON (HTTP ${res.status}): ${text.slice(0, 500)}`);
  }
  if (json.errors) {
    throw new Error(`GraphQL errors: ${JSON.stringify(json.errors)}`);
  }
  return json.data;
}

// ── 1. login ───────────────────────────────────────────────────────────
async function login() {
  const data = await gql(
    `mutation Login($input: LoginInput!) {
       login(input: $input) {
         __typename
         ... on LoginSuccessResponse { user { id } }
       }
     }`,
    { input: { email: ADMIN_EMAIL, password: ADMIN_PASSWORD } },
  );
  const r = data.login;
  if (r.__typename !== 'LoginSuccessResponse') {
    throw new Error(`login failed: ${r.__typename}`);
  }
  ids.adminUserId = r.user.id;
  saveIds();
  console.log(`✓ login (${ADMIN_EMAIL}), user ${r.user.id}`);
}

// Find the built-in ENQUEUE_AUTHOR_TO_MRT action id (auto-seeded per org; can't be
// created via GraphQL). Used as the strike-threshold escalation target.
async function findEnqueueAuthorActionId() {
  const data = await gql(
    `query($id:ID!){ org(id:$id){ actions { __typename ... on EnqueueAuthorToMrtAction { id name } } } }`,
    { id: ORG_ID },
  );
  const a = (data.org?.actions ?? []).find((x) => x.__typename === 'EnqueueAuthorToMrtAction');
  return a?.id;
}

// Resolve created ids by NAME via org(id) — the item-type mutation can't return its
// id (Coop spreads the type instead of {data}, so its `data` field is always null),
// and this also makes the whole bootstrap idempotent across re-runs.
async function orgLookup() {
  const data = await gql(
    `query Org($id: ID!) {
       org(id: $id) {
         itemTypes { ... on ContentItemType { id name } }
         actions { ... on CustomAction { id name } }
         rules { ... on ContentRule { id name } }
       }
     }`,
    { id: ORG_ID },
  );
  const org = data.org ?? {};
  // Interface members that aren't the concrete fragment type come back as {} → skip.
  const byName = (arr) =>
    new Map((arr ?? []).filter((x) => x && x.name && x.id).map((x) => [x.name, x.id]));
  return {
    itemTypes: byName(org.itemTypes),
    actions: byName(org.actions),
    rules: byName(org.rules),
  };
}

// Detailed org read used to VERIFY existing objects rather than trust them by name
// (item 4) and to wire the creatorId role / routing rule (item 1). Returns the raw
// `org` object with concrete-fragment fields populated.
async function orgDetail() {
  const data = await gql(
    `query OrgDetail($id: ID!) {
       org(id: $id) {
         itemTypes {
           __typename
           ... on ContentItemType {
             id name
             baseFields { name type required container { containerType keyScalarType valueScalarType } }
             schemaFieldRoles { displayName creatorId threadId parentId createdAt isDeleted ipAddress }
           }
           ... on UserItemType { id name isDefaultUserType }
         }
         actions {
           __typename
           ... on CustomAction {
             id name callbackUrl applyUserStrikes
             itemTypes { __typename ... on ContentItemType { id } }
           }
           ... on EnqueueAuthorToMrtAction { id name }
         }
         rules {
           __typename
           ... on ContentRule {
             id name status
             itemTypes { __typename ... on ContentItemType { id } }
             actions { __typename ... on CustomAction { id name } ... on EnqueueAuthorToMrtAction { id name } }
             policies { id name }
             conditionSet {
               conjunction
               conditions {
                 __typename
                 ... on LeafCondition {
                   input { type name }
                   signal { type }
                   matchingValues { strings }
                   comparator
                   threshold
                 }
               }
             }
           }
         }
         routingRules {
           id name status
           itemTypes { __typename ... on UserItemType { id } ... on ContentItemType { id } }
           destinationQueue { id name }
           conditionSet { conjunction conditions { __typename } }
         }
         userStrikeThresholds { threshold actions }
       }
     }`,
    { id: ORG_ID },
  );
  return data.org ?? {};
}

// Faithfully re-serialize existing BaseFields as FieldInputs so updateContentItemType
// can replace the `fields` column without dropping anything (incl. container fields).
function toFieldInputs(baseFields) {
  return (baseFields ?? []).map((f) => ({
    name: f.name,
    type: f.type,
    required: !!f.required,
    ...(f.container
      ? {
          container: {
            containerType: f.container.containerType,
            keyScalarType: f.container.keyScalarType ?? null,
            valueScalarType: f.container.valueScalarType,
          },
        }
      : {}),
  }));
}

// item 1: ensure the default User item type id (the typeId of the RELATED_ITEM author
// reference + the /items author submission). Seeded by create-org as name "User",
// isDefaultUserType:true.
async function ensureUserTypeId() {
  // Always re-discover from the live org — never trust a (possibly stale) cached id, which
  // would make the seam stamp a wrong typeId and break enqueue + routing.
  const detail = await orgDetail();
  const users = (detail.itemTypes ?? []).filter((t) => t.__typename === 'UserItemType');
  const u = users.find((t) => t.isDefaultUserType) ?? users.find((t) => t.name === 'User');
  if (!u) throw new Error('default User item type not found in org (needed for MRT author enqueue)');
  if (ids.userTypeId && ids.userTypeId !== u.id) {
    console.warn(`⚠ cached userTypeId ${ids.userTypeId} != current default User type ${u.id} — updating.`);
  }
  ids.userTypeId = u.id;
  saveIds();
  console.log(`✓ default user type ${u.name} (${u.id})`);
}

// item 1: ENQUEUE_AUTHOR_TO_MRT resolves the author via the item type's creatorId field
// role, which (DB constraint valid_field_role_field_type) MUST point at a RELATED_ITEM
// field. Add an `author` RELATED_ITEM field to ChatMessage and set creatorId -> author,
// preserving the existing fields/roles. Idempotent.
async function ensureAuthorRole() {
  const detail = await orgDetail();
  const it = (detail.itemTypes ?? []).find(
    (t) => t.__typename === 'ContentItemType' && t.name === ITEM_TYPE,
  );
  if (!it) throw new Error(`item type ${ITEM_TYPE} not found while wiring creatorId role`);
  const author = (it.baseFields ?? []).find((f) => f.name === AUTHOR_FIELD);
  if (author && author.type !== 'RELATED_ITEM') {
    throw new Error(
      `drift: ${ITEM_TYPE}.${AUTHOR_FIELD} exists but type=${author.type} (expected RELATED_ITEM). ` +
        `Rename/delete that field so bootstrap can add the creatorId-role field.`,
    );
  }
  if (author && it.schemaFieldRoles?.creatorId === AUTHOR_FIELD) {
    console.log(`✓ ${ITEM_TYPE} creatorId role -> ${AUTHOR_FIELD} (exists)`);
    return;
  }
  const fields = toFieldInputs(it.baseFields);
  if (!author) fields.push({ name: AUTHOR_FIELD, type: 'RELATED_ITEM', required: false });
  // Re-pass existing roles (so none are nulled) + set creatorId. displayName stays text.
  const fieldRoles = { displayName: it.schemaFieldRoles?.displayName ?? 'text', creatorId: AUTHOR_FIELD };
  for (const role of ['threadId', 'parentId', 'createdAt', 'isDeleted', 'ipAddress']) {
    const fn = it.schemaFieldRoles?.[role];
    if (fn) fieldRoles[role] = fn;
  }
  const data = await gql(
    `mutation UpdateItemType($input: UpdateContentItemTypeInput!) {
       updateContentItemType(input: $input) {
         __typename
         ... on ItemTypeNameAlreadyExistsError { title detail }
       }
     }`,
    { input: { id: ids.itemTypeId, fields, fieldRoles } },
  );
  const tn = data.updateContentItemType.__typename;
  if (tn !== 'MutateContentTypeSuccessResponse') {
    throw new Error(`updateContentItemType (creatorId role) -> ${tn}`);
  }
  console.log(`✓ ${ITEM_TYPE}: added ${AUTHOR_FIELD} RELATED_ITEM field + creatorId role`);
}

// ── 2. item type ─────────────────────────────────────────────────────────
async function ensureItemType(existing) {
  const found = existing.itemTypes.get(ITEM_TYPE);
  if (found) {
    ids.itemTypeId = found;
    saveIds();
    console.log(`✓ item type ${ITEM_TYPE} exists (${found})`);
    return;
  }
  const data = await gql(
    `mutation CreateItemType($input: CreateContentItemTypeInput!) {
       createContentItemType(input: $input) {
         __typename
         ... on ItemTypeNameAlreadyExistsError { title detail }
       }
     }`,
    {
      input: {
        name: ITEM_TYPE,
        description: 'Chat message turn submitted for moderation (v6 Coop-first).',
        fields: [
          { name: 'text', type: 'STRING', required: true },
          { name: 'threadId', type: 'STRING', required: false },
        ],
        // Only displayName -> text. The `threadId` ROLE requires a RELATED_ITEM-typed
        // field (DB constraint valid_field_role_field_type); our threadId is a plain
        // STRING field referenced by NAME on /content, so it needs no role.
        fieldRoles: { displayName: 'text' },
      },
    },
  );
  const tn = data.createContentItemType.__typename;
  // Success here spreads the type (data field is always null) — resolve the id by name.
  if (tn !== 'MutateContentTypeSuccessResponse' && tn !== 'ItemTypeNameAlreadyExistsError') {
    throw new Error(`createContentItemType -> ${tn}`);
  }
  const id = (await orgLookup()).itemTypes.get(ITEM_TYPE);
  if (!id) throw new Error(`item type ${ITEM_TYPE} not found after create (${tn})`);
  ids.itemTypeId = id;
  saveIds();
  console.log(`✓ item type ${ITEM_TYPE} ready (${id}, create=${tn})`);
}

// ── 3. actions ──────────────────────────────────────────────────────────
async function ensureAction(name, cacheKey, existing) {
  const found = existing.actions.get(name);
  if (found) {
    ids[cacheKey] = found;
    saveIds();
    console.log(`✓ action ${name} exists (${found})`);
    return;
  }
  const data = await gql(
    `mutation CreateAction($input: CreateActionInput!) {
       createAction(input: $input) {
         __typename
         ... on MutateActionSuccessResponse { data { id name callbackUrl } }
         ... on ActionNameExistsError { title detail }
       }
     }`,
    {
      input: {
        name,
        description: `v6 chat moderation block action (${name}).`,
        itemTypeIds: [ids.itemTypeId],
        callbackUrl: `${AUDIT_BASE}/${name}`,
        applyUserStrikes: false,
      },
    },
  );
  const r = data.createAction;
  if (r.__typename === 'MutateActionSuccessResponse') {
    ids[cacheKey] = r.data.id;
  } else if (r.__typename === 'ActionNameExistsError') {
    const id = (await orgLookup()).actions.get(name);
    if (!id) throw new Error(`action ${name} exists but not found by name`);
    ids[cacheKey] = id;
  } else {
    throw new Error(`createAction ${name} -> ${r.__typename}: ${r.title ?? ''} ${r.detail ?? ''}`);
  }
  saveIds();
  console.log(`✓ action ${name} ready (${ids[cacheKey]})`);
}

// ── 4. LIVE regex/contains rule ──────────────────────────────────────────
async function ensureRule(existing) {
  const found = existing.rules.get(RULE_NAME);
  if (found) {
    ids.ruleId = found;
    saveIds();
    console.log(`✓ rule ${RULE_NAME} exists (${found})`);
    return;
  }
  const data = await gql(
    `mutation CreateRule($input: CreateContentRuleInput!) {
       createContentRule(input: $input) {
         __typename
         ... on MutateContentRuleSuccessResponse { data { id name status } }
         ... on RuleNameExistsError { title detail }
       }
     }`,
    {
      input: {
        name: RULE_NAME,
        description: 'Proves the /content sync + LIVE-rule -> chat-block contract with a built-in token match (no model).',
        status: 'LIVE',
        contentTypeIds: [ids.itemTypeId],
        conditionSet: {
          conjunction: 'AND',
          conditions: [
            {
              input: { type: 'CONTENT_FIELD', name: 'text', contentTypeId: ids.itemTypeId },
              signal: {
                id: JSON.stringify({ type: 'TEXT_MATCHING_CONTAINS_TEXT' }),
                type: 'TEXT_MATCHING_CONTAINS_TEXT',
              },
              matchingValues: { strings: [CANARY_TOKEN] },
            },
          ],
        },
        actionIds: [ids.blockActionId],
        policyIds: [],
        tags: [],
      },
    },
  );
  const r = data.createContentRule;
  if (r.__typename === 'MutateContentRuleSuccessResponse') {
    ids.ruleId = r.data.id;
    console.log(`✓ created LIVE rule ${RULE_NAME} (${ids.ruleId}), status=${r.data.status}`);
  } else if (r.__typename === 'RuleNameExistsError') {
    const id = (await orgLookup()).rules.get(RULE_NAME);
    if (!id) throw new Error(`rule ${RULE_NAME} exists but not found by name`);
    ids.ruleId = id;
    console.log(`✓ rule ${RULE_NAME} ready (${ids.ruleId}, existed)`);
  } else {
    throw new Error(`createContentRule -> ${r.__typename}: ${r.title ?? ''} ${r.detail ?? ''}`);
  }
  saveIds();
}

// ── 5. async plane: strikes + MRT review escalation (spec §6/§9/§10.6) ──────────────
// Child-safety stays an INLINE block (chat-block-child, sync) AND now accrues per-user
// STRIKES (fire-and-forget — can't break the sync path). A strike THRESHOLD escalates the
// user to a human MRT review queue. Idempotent.
const REVIEW_QUEUE_NAME = 'child-safety-review';
const STRIKE_THRESHOLD = 3;

async function wireAsyncPlane() {
  // NOTE — strike ACCRUAL is the user's to enable. Strikes accumulate PER-POLICY: the
  // applyUserStrikeFromPublishedActions path bails unless the rule that fired has a policy
  // with userStrikeCount > 0 attached. Bootstrap intentionally does NOT create that policy
  // or the child rule (the user owns the Zentropi child rule + its strike policy in Coop).
  // What bootstrap DOES wire below is the rest of the plumbing — strikes-on-action, the MRT
  // queue, the threshold escalation, and author routing — so that once the user attaches a
  // userStrikeCount policy to their child rule, accrual → threshold → escalation just works.

  // 1. Enable strikes on the child block action (CUSTOM_ACTION — editable via GraphQL).
  await gql(
    `mutation($input: UpdateActionInput!){ updateAction(input:$input){ __typename } }`,
    { input: { id: ids.childBlockActionId, applyUserStrikes: true } },
  );
  console.log('✓ strikes enabled on chat-block-child (applyUserStrikes:true)');

  // 2. Ensure the MRT review queue exists (admin is the reviewer).
  if (!ids.reviewQueueId) {
    const data = await gql(
      `mutation($input: CreateManualReviewQueueInput!){
         createManualReviewQueue(input:$input){
           __typename
           ... on MutateManualReviewQueueSuccessResponse { data { id name } }
           ... on ManualReviewQueueNameExistsError { title }
         }
       }`,
      {
        input: {
          // userIds is EMPTY on purpose: the resolver appends the authenticated admin's
          // id, so passing it here too would duplicate the (queue_id, user_id) row and
          // trip a unique-violation that Coop misreports as ManualReviewQueueNameExistsError.
          name: REVIEW_QUEUE_NAME,
          description: 'Child-safety repeat-offender review (strike-threshold escalation).',
          userIds: [],
          hiddenActionIds: [],
          isAppealsQueue: false,
          autoCloseJobs: false,
        },
      },
    );
    const r = data.createManualReviewQueue;
    if (r.__typename === 'MutateManualReviewQueueSuccessResponse') {
      ids.reviewQueueId = r.data.id;
      console.log(`✓ created MRT review queue ${REVIEW_QUEUE_NAME} (${ids.reviewQueueId})`);
    } else if (r.__typename === 'ManualReviewQueueNameExistsError') {
      const q = await gql(`query($id:ID!){ org(id:$id){ mrtQueues { id name } } }`, { id: ORG_ID });
      ids.reviewQueueId = (q.org?.mrtQueues ?? []).find((x) => x.name === REVIEW_QUEUE_NAME)?.id;
      console.log(`✓ MRT review queue ${REVIEW_QUEUE_NAME} exists (${ids.reviewQueueId})`);
    } else {
      throw new Error(`createManualReviewQueue -> ${r.__typename}`);
    }
    saveIds();
  } else {
    console.log(`✓ MRT review queue (cached ${ids.reviewQueueId})`);
  }

  // 3. Set a user strike threshold: at N child-safety strikes → (a) fire the
  // strike-escalation webhook (works now — a CUSTOM_ACTION needs no creatorId role), and
  // (b) enqueue the author to MRT review (lands in the queue once ChatMessage has a
  // creatorId field role — see docs/v6-async-plane.md). Both are wired; (a) is demonstrable.
  const enqueueAuthorId = await findEnqueueAuthorActionId();
  if (!enqueueAuthorId) {
    throw new Error(
      'built-in ENQUEUE_AUTHOR_TO_MRT action not found in org — cannot wire the MRT author ' +
        'escalation. It is auto-seeded per org (upsertBuiltInActions); a missing one means the ' +
        'org is misconfigured. Re-seed the org or investigate before relying on MRT enqueue.',
    );
  }
  ids.enqueueAuthorActionId = enqueueAuthorId;
  saveIds();
  const thresholdActions = [ids.strikeEscalationActionId, enqueueAuthorId].filter(Boolean);
  // setAllUserStrikeThresholds REPLACES all org thresholds, so read-merge: keep any
  // existing thresholds at other levels, overwrite only ours at STRIKE_THRESHOLD.
  const existingT = await gql(
    `query($id:ID!){ org(id:$id){ userStrikeThresholds{ threshold actions } } }`,
    { id: ORG_ID },
  );
  const merged = new Map();
  for (const t of existingT.org?.userStrikeThresholds ?? []) merged.set(t.threshold, t.actions);
  merged.set(STRIKE_THRESHOLD, thresholdActions);
  const thresholds = [...merged.entries()].map(([threshold, actions]) => ({ threshold, actions }));
  await gql(
    `mutation($input: SetAllUserStrikeThresholdsInput!){ setAllUserStrikeThresholds(input:$input){ __typename } }`,
    { input: { thresholds } },
  );
  console.log(`✓ strike threshold set: ${STRIKE_THRESHOLD} strikes → strike-escalation webhook${enqueueAuthorId ? ' + enqueue-author-to-MRT' : ''}`);

  // 4. Route enqueued authors to the child-safety-review queue. The MRT job's item is the
  // author USER submission, so the routing rule matches on the USER type id. An empty AND
  // condition set always passes → catch-all for these jobs. (We can't set an existing queue
  // as the org default via the API, so a routing rule is the reliable path.)
  await ensureAuthorRouting();
}

async function ensureAuthorRouting() {
  if (!ids.userTypeId || !ids.reviewQueueId) {
    console.warn('• skipping author routing rule (need userTypeId + reviewQueueId)');
    return;
  }
  const data = await gql(
    `mutation CreateRoutingRule($input: CreateRoutingRuleInput!) {
       createRoutingRule(input: $input) {
         __typename
         ... on MutateRoutingRuleSuccessResponse { data { id } }
         ... on RoutingRuleNameExistsError { title }
         ... on QueueDoesNotExistError { title }
       }
     }`,
    {
      input: {
        name: ROUTING_RULE_NAME,
        description: 'Route child-safety repeat-offender authors (User items) to the child-safety-review queue.',
        status: 'LIVE',
        itemTypeIds: [ids.userTypeId],
        destinationQueueId: ids.reviewQueueId,
        conditionSet: { conjunction: 'AND', conditions: [] },
        isAppealsRule: false,
      },
    },
  );
  const r = data.createRoutingRule;
  if (r.__typename === 'MutateRoutingRuleSuccessResponse') {
    console.log(`✓ created author routing rule → ${REVIEW_QUEUE_NAME} (${r.data.id})`);
  } else if (r.__typename === 'RoutingRuleNameExistsError') {
    console.log(`✓ author routing rule ready (existed)`);
  } else {
    throw new Error(`createRoutingRule -> ${r.__typename}: ${r.title ?? ''}`);
  }
}

// ── 6. verify the /content sync contract ─────────────────────────────────
async function submitContent(contentId, text, userId) {
  const res = await fetch(CONTENT_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-api-key': API_KEY },
    body: JSON.stringify({
      contentType: ITEM_TYPE,
      contentId,
      content: { text, threadId: 'canary-thread' },
      ...(userId ? { userId } : {}),
      sync: true,
    }),
  });
  const text2 = await res.text();
  let json;
  try {
    json = JSON.parse(text2);
  } catch {
    json = { raw: text2 };
  }
  return { status: res.status, body: json };
}

function actionNames(body) {
  return (body.actionsTriggered ?? []).map((a) => a.name);
}

async function verify() {
  console.log('\n── verifying /content sync contract ──');
  // Enabled-rule lookup is eventually consistent (RuleEngine.ts) — a just-created rule
  // may not be visible for a beat. Poll the banned submission briefly.
  let banned;
  for (let i = 0; i < 6; i++) {
    banned = await submitContent(`canary-banned-${i}`, `please ${CANARY_TOKEN} this turn`);
    if (banned.status === 200 && actionNames(banned.body).includes(BLOCK_ACTION)) break;
    await new Promise((r) => setTimeout(r, 1000));
  }
  console.log(`banned  -> HTTP ${banned.status} actionsTriggered=${JSON.stringify(actionNames(banned.body))}`);
  const clean = await submitContent('canary-clean-1', 'what is the capital of Switzerland?');
  console.log(`clean   -> HTTP ${clean.status} actionsTriggered=${JSON.stringify(actionNames(clean.body))}`);

  const bannedOk = banned.status === 200 && actionNames(banned.body).includes(BLOCK_ACTION);
  // Strict: a clean turn must trigger NO actions at all (not just "no chat-block").
  const cleanOk = clean.status === 200 && actionNames(clean.body).length === 0;
  if (bannedOk && cleanOk) {
    console.log('\n✅ PROOF PASSED: banned token fired chat-block; clean message did not.');
    return true;
  }
  console.error('\n❌ PROOF FAILED.');
  if (!bannedOk) console.error(`  expected chat-block on banned; got ${JSON.stringify(banned.body)}`);
  if (!cleanOk) console.error(`  expected no chat-block on clean; got ${JSON.stringify(clean.body)}`);
  return false;
}

// ── 7. verify existing org config instead of trusting it by name (item 4) ────────────
// The ensure* steps resolve objects by name for idempotency, which means a STALE or
// DRIFTED object (e.g. a rule someone set to DRAFT, an action whose callbackUrl moved,
// the item type missing its creatorId role) would be reused silently. This pass reads the
// actual definitions back and FAILS LOUD on any drift from what the integration requires.
// Override with COOP_ALLOW_DRIFT=1 (warn-and-continue) only when you know the drift is OK.
async function verifyOrg() {
  console.log('\n── verifying org config (no silent drift) ──');
  const allowDrift = env.COOP_ALLOW_DRIFT === '1' || env.COOP_ALLOW_DRIFT === 'true';
  const drift = [];
  const note = (m) => {
    drift.push(m);
    console.error(`  ✗ drift: ${m}`);
  };
  const detail = await orgDetail();

  // item type: text/STRING + displayName role; author/RELATED_ITEM + creatorId role (item 1).
  const it = (detail.itemTypes ?? []).find(
    (t) => t.__typename === 'ContentItemType' && t.name === ITEM_TYPE,
  );
  if (!it) {
    note(`item type ${ITEM_TYPE} missing`);
  } else {
    const text = (it.baseFields ?? []).find((f) => f.name === 'text');
    if (!text || text.type !== 'STRING') note(`${ITEM_TYPE}.text missing or not STRING`);
    if (it.schemaFieldRoles?.displayName !== 'text') note(`${ITEM_TYPE} displayName role != "text"`);
    const author = (it.baseFields ?? []).find((f) => f.name === AUTHOR_FIELD);
    if (!author || author.type !== 'RELATED_ITEM') {
      note(`${ITEM_TYPE}.${AUTHOR_FIELD} missing or not RELATED_ITEM (MRT enqueue needs it)`);
    }
    if (it.schemaFieldRoles?.creatorId !== AUTHOR_FIELD) {
      note(`${ITEM_TYPE} creatorId role != "${AUTHOR_FIELD}"`);
    }
  }

  // actions: callbackUrl points at the audit sink, linked to the item type, child strikes on.
  const customActions = (detail.actions ?? []).filter((a) => a.__typename === 'CustomAction');
  const expectCb = {
    [BLOCK_ACTION]: `${AUDIT_BASE}/${BLOCK_ACTION}`,
    [CHILD_BLOCK_ACTION]: `${AUDIT_BASE}/${CHILD_BLOCK_ACTION}`,
    'strike-escalation': `${AUDIT_BASE}/strike-escalation`,
  };
  for (const [name, cb] of Object.entries(expectCb)) {
    const a = customActions.find((x) => x.name === name);
    if (!a) {
      note(`action ${name} missing`);
      continue;
    }
    if (a.callbackUrl !== cb) note(`action ${name} callbackUrl=${a.callbackUrl}, expected ${cb}`);
    if (!(a.itemTypes ?? []).some((t) => t.id === ids.itemTypeId)) {
      note(`action ${name} not linked to item type ${ids.itemTypeId}`);
    }
  }
  const childAction = customActions.find((x) => x.name === CHILD_BLOCK_ACTION);
  if (childAction && childAction.applyUserStrikes !== true) {
    note(`action ${CHILD_BLOCK_ACTION} applyUserStrikes != true (strikes won't accrue)`);
  }

  // rules: only the regex canary is bootstrap-owned. Verify it is LIVE, bound to ChatMessage,
  // linked to chat-block, and structurally correct (single AND leaf, TEXT_MATCHING_CONTAINS_TEXT
  // on `text`, the canary token) — a rule that drifted to DRAFT or a wrong match would silently
  // stop proving the contract. The user's Zentropi content/child rules are theirs to verify in Coop.
  const contentRules = (detail.rules ?? []).filter((r) => r.__typename === 'ContentRule');
  const singleLeaf = (r) => {
    const cs = r.conditionSet;
    const conds = cs?.conditions ?? [];
    if (cs?.conjunction !== 'AND' || conds.length !== 1 || conds[0].__typename !== 'LeafCondition') return null;
    return conds[0];
  };
  const expectRules = [
    { name: RULE_NAME, action: ids.blockActionId, signal: 'TEXT_MATCHING_CONTAINS_TEXT', match: CANARY_TOKEN },
  ];
  for (const er of expectRules) {
    const r = contentRules.find((x) => x.name === er.name);
    if (!r) {
      note(`rule ${er.name} missing`);
      continue;
    }
    if (r.status !== 'LIVE') note(`rule ${er.name} status=${r.status}, expected LIVE`);
    if (!(r.itemTypes ?? []).some((t) => t.id === ids.itemTypeId)) note(`rule ${er.name} not bound to ${ITEM_TYPE}`);
    if (er.action && !(r.actions ?? []).some((a) => a.id === er.action)) {
      note(`rule ${er.name} not linked to its expected action`);
    }
    const leaf = singleLeaf(r);
    if (!leaf) {
      note(`rule ${er.name} condition is not a single AND leaf`);
    } else {
      // the leaf must evaluate the `text` content field — a right-signal rule pointed at the
      // wrong field would pass every other check while moderating nothing.
      if (leaf.input?.type !== 'CONTENT_FIELD') note(`rule ${er.name} input.type=${leaf.input?.type}, expected CONTENT_FIELD`);
      if (leaf.input?.name !== 'text') note(`rule ${er.name} input.name=${JSON.stringify(leaf.input?.name)}, expected "text"`);
      if (er.signal && leaf.signal?.type !== er.signal) note(`rule ${er.name} signal=${leaf.signal?.type}, expected ${er.signal}`);
      if (er.threshold !== undefined) {
        if (leaf.comparator !== 'GREATER_THAN_OR_EQUALS') note(`rule ${er.name} comparator=${leaf.comparator}, expected GREATER_THAN_OR_EQUALS`);
        if (Number(leaf.threshold) !== er.threshold) note(`rule ${er.name} threshold=${leaf.threshold}, expected ${er.threshold}`);
      }
      if (er.match && !((leaf.matchingValues?.strings) ?? []).includes(er.match)) note(`rule ${er.name} match strings missing "${er.match}"`);
    }
  }

  // routing rule (item 1): LIVE, bound to the User type, destination = child-safety-review.
  if (ids.userTypeId && ids.reviewQueueId) {
    const rr = (detail.routingRules ?? []).find((x) => x.name === ROUTING_RULE_NAME);
    if (!rr) {
      note(`routing rule ${ROUTING_RULE_NAME} missing`);
    } else {
      if (rr.status !== 'LIVE') note(`routing rule ${ROUTING_RULE_NAME} status=${rr.status}, expected LIVE`);
      if (!(rr.itemTypes ?? []).some((t) => t.id === ids.userTypeId)) note(`routing rule not bound to User type ${ids.userTypeId}`);
      if (rr.destinationQueue?.id !== ids.reviewQueueId) note(`routing rule destination=${rr.destinationQueue?.id}, expected ${ids.reviewQueueId}`);
      // must be a CATCH-ALL (empty AND) so every author MRT job routes here, else the org
      // default queue would silently win for jobs the condition doesn't match.
      const rcs = rr.conditionSet;
      if (rcs?.conjunction !== 'AND' || (rcs?.conditions ?? []).length !== 0) {
        note(`routing rule ${ROUTING_RULE_NAME} not a catch-all (conjunction=${rcs?.conjunction}, conditions=${(rcs?.conditions ?? []).length})`);
      }
    }
  }

  // strike threshold (item 1): threshold = STRIKE_THRESHOLD fires BOTH the escalation webhook
  // AND enqueue-author-to-MRT. Verify both action ids are present at that level.
  const t = (detail.userStrikeThresholds ?? []).find((x) => x.threshold === STRIKE_THRESHOLD);
  if (!t) {
    note(`no user strike threshold at ${STRIKE_THRESHOLD}`);
  } else {
    for (const [label, id] of [
      ['strike-escalation', ids.strikeEscalationActionId],
      ['enqueue-author-to-MRT', ids.enqueueAuthorActionId],
    ]) {
      if (id && !(t.actions ?? []).includes(id)) note(`strike threshold ${STRIKE_THRESHOLD} missing ${label} action`);
    }
  }

  if (drift.length === 0) {
    console.log('✓ org config verified — no drift');
    return;
  }
  if (allowDrift) {
    console.warn(`⚠ ${drift.length} drift item(s) found; COOP_ALLOW_DRIFT set → continuing.`);
    return;
  }
  throw new Error(
    `${drift.length} config drift item(s) found (see ✗ lines above). Fix them (or delete the ` +
      `drifted object so bootstrap recreates it), or set COOP_ALLOW_DRIFT=1 to bypass.`,
  );
}

async function main() {
  console.log(`Coop bootstrap @ ${COOP_URL}`);
  await login();
  const existing = await orgLookup(); // look up first; create only what's missing (Coop 500s on dup create)
  await ensureItemType(existing);
  await ensureAuthorRole(); // item 1: creatorId RELATED_ITEM field + role on ChatMessage
  await ensureUserTypeId(); // item 1: default User type id (for /content author + /items)
  await ensureAction(BLOCK_ACTION, 'blockActionId', existing);
  await ensureAction(CHILD_BLOCK_ACTION, 'childBlockActionId', existing);
  // Escalation webhook fired when a user crosses the strike threshold (async plane).
  await ensureAction('strike-escalation', 'strikeEscalationActionId', existing);
  await ensureRule(existing);
  await wireAsyncPlane();
  await verifyOrg(); // item 4: read back + fail loud on config drift
  const ok = await verify();
  console.log(`\n→ chat app env (enables MRT author enqueue): COOP_USER_TYPE_ID=${ids.userTypeId ?? '(unknown)'}`);
  console.log(
    '\nNEXT (your Coop setup, in the dashboard):\n' +
      '  • Add Zentropi creds + labelers, then author your content + child rules\n' +
      '    (map CoPE scores → chat-block / chat-block-child).\n' +
      '  • For STRIKES to accrue: attach a policy with userStrikeCount > 0 to your child rule\n' +
      '    (without it, applyUserStrikeFromPublishedActions bails and no strikes are counted).\n' +
      '  • For child-safety to be truly FAIL-CLOSED on a Zentropi outage: add a companion child\n' +
      "    rule using the Zentropi child signal's IS_UNAVAILABLE condition → chat-block-child.",
  );
  process.exit(ok ? 0 : 1);
}

main().catch((err) => {
  console.error('bootstrap failed:', err.message);
  process.exit(1);
});
