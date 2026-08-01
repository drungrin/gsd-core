'use strict';
/**
 * github-sync-operation.cts — the single shared operation contract for the
 * github-sync capability's mutation and adoption stages (D-09/D-10, plan
 * 03-01). A pure module with zero I/O imports: it has no consumers yet —
 * plan 03-02 migrates `github-sync-apply.cts` and `github-sync-reconcile.cts`
 * onto it, deleting the two divergent `MutationOperation` declarations this
 * module replaces.
 *
 * Two shapes make up the contract:
 *
 * - `MutationOperation` / `MutationPlan.operations` — things to dispatch.
 *   Late-bindable argv (`ArgvEntry`), a per-operation response transport, a
 *   declared action, a points-budget flag, and one or more response
 *   captures that can fan one response out to several completions.
 * - `AdoptionCheckpoint` / `MutationPlan.checkpoints` — the mutation-free
 *   half of the checkpoint-on-noop contract stated in full in plan 03-01's
 *   `<checkpoint_contract>`. Each entry records an object GSD *observed* to
 *   be already correct; it dispatches no process and consumes no points.
 *   This is what makes BOOT-06 reachable on the adopt-and-repair path, where
 *   every stage correctly plans a noop and a noop dispatches nothing.
 *
 * `OperationOutcome` is the per-run journal entry that lets a consumer tell
 * an object GSD created this run from one it merely found already correct —
 * `confirmedKeys`, `checkpointedKeys`, and `mutatedKeys` are the three
 * logical-key selectors over that journal (see each function's doc comment
 * for the aggregation rule each one answers).
 *
 * SECURITY — the raw-versus-typed argv flag rule, stated once here because
 * this is the one place every later operation builder will read it from:
 * every GraphQL string variable whose value originates outside GitHub —
 * anything from `.planning/config.json`, from ROADMAP or STATE text, or any
 * field/option/label/milestone name, title, colour, or description — rides
 * the raw `-f` flag. The typed `-F` flag is permitted only for validated
 * positive integers and for opaque node ids GitHub itself minted that GSD is
 * echoing back verbatim (the pre-existing case in
 * `src/github-sync-reconcile.cts:50`). New bootstrap code puts node ids on
 * the raw flag too: there is no typing benefit and the raw flag is strictly
 * safer. This module does not itself choose `-f`/`-F` — that choice lives in
 * each `ArgvEntry`'s literal flag string, supplied by the operation's
 * builder — but the rule is recorded here so no builder has to rediscover
 * it.
 */

/** GraphQL responses decode through the `data` envelope; REST responses are a bare JSON object. */
export const OPERATION_TRANSPORT = Object.freeze({
  GRAPHQL: 'graphql',
  REST: 'rest',
} as const);
export type OperationTransport = typeof OPERATION_TRANSPORT[keyof typeof OPERATION_TRANSPORT];

/** Which slot of a referenced completion an `ArgvRef` resolves. */
export const ARGV_REF_PART = Object.freeze({
  NODE_ID: 'nodeId',
  NUMBER: 'number',
} as const);
export type ArgvRefPart = typeof ARGV_REF_PART[keyof typeof ARGV_REF_PART];

/**
 * `observe` is reserved for `AdoptionCheckpoint`s and is never carried by a
 * dispatched `MutationOperation` — `isOperation` rejects it.
 */
export const OPERATION_ACTION = Object.freeze({
  CREATE: 'create',
  UPDATE: 'update',
  LINK: 'link',
  OBSERVE: 'observe',
} as const);
export type OperationAction = typeof OPERATION_ACTION[keyof typeof OPERATION_ACTION];

/**
 * `confirmed` — durably written during this run. `unchanged` — already
 * recorded identically; nothing written. `already-exists` — the remote
 * refused a create because the object exists, so no completion was
 * recorded.
 */
export const OPERATION_OUTCOME = Object.freeze({
  CONFIRMED: 'confirmed',
  UNCHANGED: 'unchanged',
  ALREADY_EXISTS: 'already-exists',
} as const);
export type OperationOutcomeResult = typeof OPERATION_OUTCOME[keyof typeof OPERATION_OUTCOME];

/** The repository binding every `SyncCompletion` carries (checkpoint contract clause 1a). */
export interface CompletionContext {
  owner: string;
  repo: string;
  repositoryNumber: number;
}

/**
 * A late-bound argv reference. `from` names a logical key whose completion
 * must already be in the map when this operation dispatches — either from a
 * prior run, from an adoption checkpoint folded at the head of this run, or
 * from an earlier operation in this same plan. `prefix` is concatenated
 * directly onto the resolved value (e.g. `projectId=`); the flag itself
 * (`-f`/`-F`) is always a separate literal argv entry, never part of the
 * prefix, so a flag-adjacency assertion still sees a flag immediately
 * before every value.
 */
export interface ArgvRef {
  from: string;
  part: ArgvRefPart;
  prefix: string;
}

/** A plain literal or a late-bound reference. */
export type ArgvEntry = string | ArgvRef;

/**
 * A single-value capture. Both `nodeIdPath` and `numberPath` address a
 * scalar relative to the decoded response root: the node-id path must
 * resolve to a non-empty string, and the number path — when declared and
 * present — to a positive safe integer.
 */
export interface NodeCapture {
  kind: 'node';
  logicalKey: string;
  nodeIdPath: string;
  numberPath?: string;
}

/**
 * A fan-out capture over a list in the response. `listPath` addresses the
 * array; `matchPath` and `nodeIdPath` are relative to each element. `keyMap`
 * is a plain, planner-supplied map from the matched scalar value to the
 * reserved logical key it should be checkpointed under — no slug logic ever
 * enters this module. An element whose match value is absent from the key
 * map is skipped: GSD checkpoints only what GSD declares.
 */
export interface EachCapture {
  kind: 'each';
  listPath: string;
  matchPath: string;
  nodeIdPath: string;
  numberPath?: string;
  keyMap: Record<string, string>;
}

export type ResponseCapture = NodeCapture | EachCapture;

/**
 * A dispatchable mutation. `logicalKey` is the operation's own identity —
 * used for retry notices, failure reporting, and pacing — and is not
 * necessarily a completion key (an each-capture can fan one operation out
 * to several completion keys).
 */
export interface MutationOperation {
  kind: string;
  logicalKey: string;
  args: ArgvEntry[];
  completionContext: CompletionContext;
  transport: OperationTransport;
  action: OperationAction;
  hasPointsBudget: boolean;
  contentCreation: boolean;
  captures: ResponseCapture[];
}

/**
 * The mutation-free half of the checkpoint contract: an instruction to
 * record an object GSD observed to be already correct. It carries no argv,
 * no transport, and no captures, because it dispatches nothing.
 */
export interface AdoptionCheckpoint {
  logicalKey: string;
  nodeId: string;
  remoteNumber?: number;
  completionContext: CompletionContext;
}

/** The checkpoint list is optional so Phase 2's reconciliation plan satisfies the type without change. */
export interface MutationPlan {
  operations: MutationOperation[];
  checkpoints?: AdoptionCheckpoint[];
}

/**
 * A per-run journal entry. `operationKey` is the producing operation's own
 * `logicalKey`, or `null` for an observation (which dispatches nothing).
 * One `updateProjectV2Field` can fan out to five `option:status:*`
 * completions sharing one `operationKey` — a consumer counting remote work
 * counts distinct non-null `operationKey` values, never completion keys.
 */
export interface OperationOutcome {
  logicalKey: string;
  operationKey: string | null;
  action: OperationAction;
  result: OperationOutcomeResult;
}

/** A decoded completion, before the caller merges in the operation's `completionContext`. */
export interface DecodedCompletion {
  logicalKey: string;
  nodeId: string;
  remoteNumber?: number;
  completedAt: string;
}

/** A minimal lookup shape for `resolveArgv` — deliberately not `SyncCompletion` itself. */
export interface CompletionLookup {
  nodeId: string;
  remoteNumber?: number;
}
export type CompletionLookupMap = Record<string, CompletionLookup>;

export type ResolveArgvResult =
  | { ok: true; argv: string[] }
  | { ok: false; missingLogicalKey: string };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

function isPositiveSafeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
}

function isCompletionContext(value: unknown): value is CompletionContext {
  if (!isRecord(value)) return false;
  return isNonEmptyString(value.owner) && isNonEmptyString(value.repo) && isPositiveSafeInteger(value.repositoryNumber);
}

export function isArgvRef(value: unknown): value is ArgvRef {
  if (!isRecord(value)) return false;
  return isNonEmptyString(value.from) &&
    (value.part === ARGV_REF_PART.NODE_ID || value.part === ARGV_REF_PART.NUMBER) &&
    typeof value.prefix === 'string';
}

function isValidCapture(capture: unknown): capture is ResponseCapture {
  if (!isRecord(capture)) return false;
  const numberPathOk = capture.numberPath === undefined || isNonEmptyString(capture.numberPath);
  if (capture.kind === 'node') {
    return isNonEmptyString(capture.logicalKey) && isNonEmptyString(capture.nodeIdPath) && numberPathOk;
  }
  if (capture.kind === 'each') {
    return isNonEmptyString(capture.listPath) && isNonEmptyString(capture.matchPath) &&
      isNonEmptyString(capture.nodeIdPath) && numberPathOk && isRecord(capture.keyMap);
  }
  return false;
}

/**
 * Rejects an operation with an empty captures array, a capture with an
 * empty node-id path, an argv entry that is neither a string nor a
 * well-formed reference, an unknown transport value, an unknown or
 * `observe` action value (reserved for adoption checkpoints), and a
 * non-boolean points-budget flag.
 */
export function isOperation(operation: MutationOperation): boolean {
  const context = operation.completionContext;
  return isNonEmptyString(operation.logicalKey) &&
    Array.isArray(operation.args) && operation.args.every((arg) => typeof arg === 'string' || isArgvRef(arg)) &&
    (operation.transport === OPERATION_TRANSPORT.GRAPHQL || operation.transport === OPERATION_TRANSPORT.REST) &&
    (operation.action === OPERATION_ACTION.CREATE || operation.action === OPERATION_ACTION.UPDATE || operation.action === OPERATION_ACTION.LINK) &&
    typeof operation.hasPointsBudget === 'boolean' &&
    typeof operation.contentCreation === 'boolean' &&
    Array.isArray(operation.captures) && operation.captures.length > 0 && operation.captures.every(isValidCapture) &&
    isCompletionContext(context);
}

/**
 * Accepts an entry carrying a non-empty logical key, a non-empty string
 * node id, a well-formed completion context, and either no remote number or
 * a positive safe integer. Rejects an empty logical key, an empty node id,
 * a node id supplied as a number, a zero/negative/fractional remote number,
 * and a missing or malformed completion context.
 */
export function isAdoptionCheckpoint(value: AdoptionCheckpoint): boolean {
  return isNonEmptyString(value.logicalKey) && isNonEmptyString(value.nodeId) &&
    (value.remoteNumber === undefined || isPositiveSafeInteger(value.remoteNumber)) &&
    isCompletionContext(value.completionContext);
}

/**
 * Resolves late-bound argv against a completions lookup. Plain strings pass
 * through untouched. A reference resolves to its prefix concatenated with
 * the referenced completion's node id (or, for a number reference, its
 * remote-number slot rendered as a decimal string). Returns an unresolved
 * result naming the missing logical key when the map is null, the key is
 * absent, the referenced node id is the empty string, or a number
 * reference points at a completion with no number slot.
 */
export function resolveArgv(argv: ArgvEntry[], map: CompletionLookupMap | null): ResolveArgvResult {
  const resolved: string[] = [];
  for (const entry of argv) {
    if (typeof entry === 'string') {
      resolved.push(entry);
      continue;
    }
    const completion = map ? map[entry.from] : undefined;
    if (!completion) return { ok: false, missingLogicalKey: entry.from };
    if (entry.part === ARGV_REF_PART.NODE_ID) {
      if (!isNonEmptyString(completion.nodeId)) return { ok: false, missingLogicalKey: entry.from };
      resolved.push(`${entry.prefix}${completion.nodeId}`);
    } else {
      if (completion.remoteNumber === undefined) return { ok: false, missingLogicalKey: entry.from };
      resolved.push(`${entry.prefix}${completion.remoteNumber}`);
    }
  }
  return { ok: true, argv: resolved };
}

/** GitHub REST error bodies carry a `message` string and lack both success-indicating keys. */
const REST_SUCCESS_KEYS = ['id', 'node_id'] as const;

function isRestErrorBody(value: Record<string, unknown>): boolean {
  if (typeof value.message !== 'string') return false;
  return !REST_SUCCESS_KEYS.some((key) => key in value);
}

/**
 * Decodes a raw `gh` stdout body into the response root a capture reads
 * from. GraphQL keeps the existing `parseData` behavior — including the
 * errors-array rejection — and returns the inner `data` object. REST bodies
 * are bare JSON objects (verified live against a real label create): the
 * top-level parsed object is returned directly, with arrays, unparseable
 * text, and the REST error shape all rejected as null. The error shape is
 * defined as a `message` string with none of the expected success keys,
 * deliberately not gated on `status`'s type: a live probe returns `status`
 * as a **string**, and typing that field would let a real error body
 * through.
 */
export function decodeResponseRoot(transport: OperationTransport, stdout: string): Record<string, unknown> | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    return null;
  }
  if (!isRecord(parsed)) return null;

  if (transport === OPERATION_TRANSPORT.GRAPHQL) {
    const errors = parsed.errors;
    if (Array.isArray(errors) && errors.length > 0) return null;
    const data = parsed.data;
    return isRecord(data) ? data : null;
  }

  if (isRestErrorBody(parsed)) return null;
  return parsed;
}

function getAtPath(root: unknown, path: string): unknown {
  let cursor: unknown = root;
  for (const part of path.split('.')) {
    if (!isRecord(cursor)) return undefined;
    cursor = cursor[part];
  }
  return cursor;
}

function decodeNumberAt(root: unknown, numberPath: string | undefined): { ok: true; value: number | undefined } | { ok: false } {
  if (numberPath === undefined) return { ok: true, value: undefined };
  const raw = getAtPath(root, numberPath);
  if (raw === undefined) return { ok: true, value: undefined };
  if (!isPositiveSafeInteger(raw)) return { ok: false };
  return { ok: true, value: raw };
}

/**
 * Decodes every capture on `operation` against a response root already
 * produced by `decodeResponseRoot`. A single node capture yields a
 * one-element array; an each capture yields one completion per element
 * whose match value appears in the capture's key map, in list order.
 * Fails closed (returns null) when `root` is null, when a node-id path is
 * absent/non-string/empty, when a declared number path resolves to
 * something other than a positive safe integer, or when an each-capture
 * matches zero elements — a mutation that reported success but returned
 * none of GSD's own objects must never silently checkpoint nothing.
 */
export function decodeCompletions(operation: MutationOperation, root: Record<string, unknown> | null, completedAt: string): DecodedCompletion[] | null {
  if (root === null) return null;
  const results: DecodedCompletion[] = [];

  for (const capture of operation.captures) {
    if (capture.kind === 'node') {
      const nodeId = getAtPath(root, capture.nodeIdPath);
      if (!isNonEmptyString(nodeId)) return null;
      const number = decodeNumberAt(root, capture.numberPath);
      if (!number.ok) return null;
      results.push({
        logicalKey: capture.logicalKey,
        nodeId,
        completedAt,
        ...(number.value === undefined ? {} : { remoteNumber: number.value }),
      });
      continue;
    }

    const list = getAtPath(root, capture.listPath);
    if (!Array.isArray(list)) return null;
    let matchedAny = false;
    for (const element of list) {
      const matchValue = getAtPath(element, capture.matchPath);
      const logicalKey = typeof matchValue === 'string' || typeof matchValue === 'number'
        ? capture.keyMap[String(matchValue)]
        : undefined;
      if (logicalKey === undefined) continue;

      const nodeId = getAtPath(element, capture.nodeIdPath);
      if (!isNonEmptyString(nodeId)) return null;
      const number = decodeNumberAt(element, capture.numberPath);
      if (!number.ok) return null;
      results.push({
        logicalKey,
        nodeId,
        completedAt,
        ...(number.value === undefined ? {} : { remoteNumber: number.value }),
      });
      matchedAny = true;
    }
    if (!matchedAny) return null;
  }

  return results.length > 0 ? results : null;
}

/** The keys whose result is confirmed, in dispatch order, with duplicates preserved (never deduplicated). */
export function confirmedKeys(outcomes: OperationOutcome[]): string[] {
  return outcomes.filter((outcome) => outcome.result === OPERATION_OUTCOME.CONFIRMED).map((outcome) => outcome.logicalKey);
}

/** The keys present in the map — confirmed or unchanged — excluding an already-exists result. */
export function checkpointedKeys(outcomes: OperationOutcome[]): string[] {
  return outcomes
    .filter((outcome) => outcome.result === OPERATION_OUTCOME.CONFIRMED || outcome.result === OPERATION_OUTCOME.UNCHANGED)
    .map((outcome) => outcome.logicalKey);
}

/** The keys that actually changed the remote this run: confirmed, and not an observation. */
export function mutatedKeys(outcomes: OperationOutcome[]): string[] {
  return outcomes
    .filter((outcome) => outcome.result === OPERATION_OUTCOME.CONFIRMED && outcome.action !== OPERATION_ACTION.OBSERVE)
    .map((outcome) => outcome.logicalKey);
}
