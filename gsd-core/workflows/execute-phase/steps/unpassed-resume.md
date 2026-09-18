Apply response_language to all user-facing prose — narration between tool calls, status updates, progress notes, and findings included; preserve code, paths, and identifiers.

<step name="unpassed_resume">
Every plan is summarized, the phase is not marked complete, and a VERIFICATION.md exists whose
status is **not** `passed` — `gaps_found`, `human_needed`, or `unknown` (#4765). The report is
present but it is not a verdict that anything may be built on.

This is NOT the #3684 state. There the verdict was `passed` and only the roadmap write was
missing, so resuming at `update_roadmap` finished a run that had genuinely succeeded. Here the
old `VERIFY_STATUS ≠ missing` branch sent these three statuses down that same route, which
announced the phase as verified when it is not, skipped `verify_phase_goal`, and then
dead-ended at the completion gate — `phase.complete`
refuses a non-`passed` verdict, so the only possible outcome was an error contradicting the
message that led there.

Read the status's own routing rather than restating it here — `verification.status` is the single
owner of what each status means and what to do next, and a second copy in this workflow is how
the two came to disagree in the first place:

```bash
VERIFY_JSON=$(gsd_run query verification status "${PHASE_DIR}")
if [[ "$VERIFY_JSON" == @file:* ]]; then VERIFY_JSON=$(cat "${VERIFY_JSON#@file:}"); fi
VERIFY_NEXT_ACTION=$(echo "$VERIFY_JSON" | jq -r '.next_action // ""')
VERIFY_NEXT_COMMAND=$(echo "$VERIFY_JSON" | jq -r '.next_command // ""')
```

Report, then exit — do NOT continue at `update_roadmap`, and do NOT claim the phase is verified:

```
"Phase {X}: every plan is summarized, but verification is {VERIFY_STATUS}, not passed.
{VERIFY_NEXT_ACTION}
Next: {VERIFY_NEXT_COMMAND}"
```

Omit the `Next:` line when `next_command` is empty.

**Why exit rather than re-verify.** Each of these three needs something this run cannot supply,
and each has a different owner:

| Status | Why re-running the verifier here would not help |
|---|---|
| `gaps_found` | The verifier already reported what is missing. Closing gaps is planning work — `next_command` routes to gap-closure planning, not to another verification pass over the same tree |
| `human_needed` | A person has to complete the phase's `*-UAT.md` first; re-dispatching the verifier before that produces the identical verdict |
| `unknown` | The status value is not one the verifier emits, so it was hand-set (a `failed`/`superseded` marker, say). Regenerating would overwrite a deliberate human record — `next_action` says as much, and the decision is the user's |

`stale` is the one non-`passed` status that re-verification DOES fix, and it is handled ahead of
this arm by `execute-phase/steps/stale-reverification.md` — there the report is only out of date
with the tree, not a standing negative verdict.
</step>
