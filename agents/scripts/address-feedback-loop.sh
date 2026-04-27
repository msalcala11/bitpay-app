#!/usr/bin/env bash
# review-loop.sh — Paste feedback, then run an implementer/reviewer loop until clean or max rounds reached
set -euo pipefail

# ── Config ───────────────────────────────────────────────────────────
MAX_ROUNDS="${MAX_ROUNDS:-3}"        # How many review rounds before giving up
MODEL="${MODEL:-gpt-5.5}"
REASONING="${REASONING:-xhigh}"
PLAN_FILE="${PLAN_FILE:-agents/portfolio-refactor-implementation-plan.md}"

# ── Setup ────────────────────────────────────────────────────────────
REPO_ROOT="$(git rev-parse --show-toplevel 2>/dev/null)" || {
  echo "Error: not in a git repo" >&2
  exit 1
}
cd "$REPO_ROOT"

# Resolve plan file to an absolute path so prompts are unambiguous regardless
# of where the agent decides its working directory is
if [[ "$PLAN_FILE" = /* ]]; then
  PLAN_PATH="$PLAN_FILE"
else
  PLAN_PATH="$REPO_ROOT/$PLAN_FILE"
fi

if [[ ! -f "$PLAN_PATH" ]]; then
  echo "Error: plan file not found at $PLAN_PATH" >&2
  echo "Set PLAN_FILE env var to override (default: agents/portfolio-refactor-implementation-plan.md)" >&2
  exit 1
fi

# Require a clean working tree so the diff captures only this loop's changes
if [[ -n "$(git status --porcelain)" ]]; then
  echo "Error: working tree has uncommitted changes." >&2
  echo "Commit or stash before running this loop so diffs reflect only the agent's work." >&2
  exit 1
fi

STATE_DIR="$REPO_ROOT/.codex-state"
mkdir -p "$STATE_DIR"
TIMESTAMP=$(date +%Y%m%d-%H%M%S)
SESSION_DIR="$STATE_DIR/session-$TIMESTAMP"
mkdir -p "$SESSION_DIR"

TASK_FILE="$SESSION_DIR/TASK.md"
LOG_DIR="$SESSION_DIR/logs"
mkdir -p "$LOG_DIR"

# Baseline commit so we can produce diffs of just the agent's work
BASELINE_REF=$(git rev-parse HEAD)

echo "─────────────────────────────────────────────────────────────────────"
echo "Review Loop"
echo "─────────────────────────────────────────────────────────────────────"
echo "Session:    $SESSION_DIR"
echo "Plan:       $PLAN_PATH"
echo "Baseline:   $BASELINE_REF"
echo "Max rounds: $MAX_ROUNDS"
echo "Model:      $MODEL ($REASONING reasoning)"
echo "─────────────────────────────────────────────────────────────────────"
echo ""

# ── Step 1: Collect initial feedback ─────────────────────────────────
echo "Paste the initial feedback below."
echo "Press Ctrl+D on a new line when done (or Ctrl+C to abort)."
echo "─────────────────────────────────────────────────────────────────────"
INITIAL_FEEDBACK=$(cat)

if [[ -z "${INITIAL_FEEDBACK// }" ]]; then
  echo "Error: no feedback provided." >&2
  exit 1
fi

# Initialize the task file. The implementer reads this every round.
cat > "$TASK_FILE" <<EOF
# Review Loop Task

This file is the single source of truth for this implementation task.
It is updated each round with new reviewer feedback.

## Implementation plan

This work is part of an overall plan documented at:
$PLAN_PATH

All implementation and review decisions must align with that plan. The plan
defines the goals, scope, phases, and acceptance criteria. Both the implementer
and the reviewer should re-read it at the start of each round to ground their
judgment in the plan's intent rather than just the local diff.

## Original feedback

$INITIAL_FEEDBACK

## Reviewer feedback rounds

(none yet — initial implementation in progress)
EOF

echo ""
echo "→ Task file written to $TASK_FILE"
echo ""

# ── Helpers ──────────────────────────────────────────────────────────

# Run codex exec with our standard flags. Logs to file, returns stdout.
run_codex() {
  local label="$1"   # e.g. "implement-round1", "review-round1"
  local sandbox="$2" # "workspace-write" or "read-only"
  local prompt="$3"
  local log_file="$LOG_DIR/$label.log"

  echo "  ↳ logging to $log_file"

  codex exec \
    -m "$MODEL" \
    -c model_reasoning_effort="$REASONING" \
    --sandbox "$sandbox" \
    "$prompt" 2>&1 | tee "$log_file"
}

# Append a new reviewer feedback round to the task file
append_feedback_round() {
  local round_num="$1"
  local feedback="$2"

  # Replace "(none yet ...)" placeholder on first round
  if grep -q "^(none yet" "$TASK_FILE"; then
    awk '!/^\(none yet/' "$TASK_FILE" > "$TASK_FILE.tmp" && mv "$TASK_FILE.tmp" "$TASK_FILE"
  fi

  cat >> "$TASK_FILE" <<EOF

### Round $round_num — $(date +%Y-%m-%d\ %H:%M:%S)

$feedback
EOF
}

# Extract verdict from reviewer output
extract_verdict() {
  local output="$1"
  echo "$output" | grep -oE "VERDICT:\s*(APPROVE|CHANGES_REQUESTED)" | tail -1 | awk '{print $2}'
}

# ── Step 2: Initial implementation ───────────────────────────────────
echo "─────────────────────────────────────────────────────────────────────"
echo "→ Round 0: Initial implementation"
echo "─────────────────────────────────────────────────────────────────────"

IMPLEMENT_PROMPT="A senior reviewer provided feedback on this repo. The full task is recorded at $TASK_FILE.

CRITICAL CONTEXT:
- Read the implementation plan at $PLAN_PATH FIRST. This plan defines the overall goals and scope of the work — every change you make should be consistent with it.
- Then read $TASK_FILE in full to understand the specific feedback you must address.

Address every concern raised in the 'Original feedback' section of the task file. Make the necessary code edits and run any relevant tests. At the end, summarize what you changed, why, and how it aligns with the plan.

If any feedback is ambiguous, conflicts with existing code, or appears to contradict the plan, flag it explicitly rather than guessing."

run_codex "implement-round0" "workspace-write" "$IMPLEMENT_PROMPT"

# Verify the agent actually changed something
if [[ -z "$(git diff "$BASELINE_REF")" ]]; then
  echo ""
  echo "✗ Agent made no changes. Aborting loop."
  exit 1
fi

# ── Step 3: Review/correct loop ──────────────────────────────────────
ROUND=1
FINAL_VERDICT=""

while (( ROUND <= MAX_ROUNDS )); do
  echo ""
  echo "─────────────────────────────────────────────────────────────────────"
  echo "→ Round $ROUND of $MAX_ROUNDS: Reviewer assessing changes"
  echo "─────────────────────────────────────────────────────────────────────"

  DIFF=$(git diff "$BASELINE_REF")
  DIFF_FILE="$SESSION_DIR/round-$ROUND.diff"
  echo "$DIFF" > "$DIFF_FILE"

  REVIEW_PROMPT="You are a strict, independent code reviewer. Another agent made changes to this repo in response to feedback. Your job is to assess whether those changes correctly and completely address the original feedback AND remain aligned with the overall implementation plan.

CRITICAL CONTEXT — read these files in order before reviewing:
1. The implementation plan at $PLAN_PATH. This defines the goals, scope, phases, and acceptance criteria. Use it as your primary frame of reference for what 'correct' looks like.
2. The task history at $TASK_FILE. This contains the original feedback and any prior review rounds.
3. The cumulative diff at $DIFF_FILE. This is the change set you are reviewing.

Assessment criteria:
- Does the implementation align with the plan's goals and scope? Has it drifted into out-of-scope work?
- Has every concern in the original feedback been addressed?
- Have all subsequent reviewer rounds been addressed?
- Are there bugs, edge cases, or regressions introduced by the changes?
- Are there new issues the changes may have created?
- Does the work meet the plan's acceptance criteria for the relevant phase?

Be concrete and specific. When you raise an issue, point to specific files and lines, and tie it back to the plan or the original feedback when possible.

Format your response as:

ALIGNMENT WITH PLAN:
<your assessment of how the changes align with $PLAN_PATH>

FEEDBACK FOR IMPLEMENTER:
<everything the implementer needs to address — bugs, missed requirements, plan misalignments, etc. Leave empty if approving.>

VERDICT: APPROVE
or
VERDICT: CHANGES_REQUESTED

The 'FEEDBACK FOR IMPLEMENTER' section will be passed verbatim to the implementer if you choose CHANGES_REQUESTED."

  REVIEW_OUTPUT=$(run_codex "review-round$ROUND" "read-only" "$REVIEW_PROMPT")

  VERDICT=$(extract_verdict "$REVIEW_OUTPUT")

  if [[ -z "$VERDICT" ]]; then
    echo ""
    echo "✗ Could not parse a VERDICT line from the reviewer's response."
    echo "  Treating this as inconclusive — see the log and decide manually:"
    echo "  $LOG_DIR/review-round$ROUND.log"
    FINAL_VERDICT="UNCLEAR"
    break
  fi

  echo ""
  echo "→ Reviewer verdict: $VERDICT"

  if [[ "$VERDICT" == "APPROVE" ]]; then
    FINAL_VERDICT="APPROVE"
    break
  fi

  # CHANGES_REQUESTED — extract the feedback section
  REVIEWER_FEEDBACK=$(echo "$REVIEW_OUTPUT" | awk '
    /FEEDBACK FOR IMPLEMENTER:/ { capture = 1; next }
    /^VERDICT:/ { capture = 0 }
    capture { print }
  ')

  if [[ -z "${REVIEWER_FEEDBACK// }" ]]; then
    echo "  (Reviewer did not use 'FEEDBACK FOR IMPLEMENTER:' marker; using full review output)"
    REVIEWER_FEEDBACK="$REVIEW_OUTPUT"
  fi

  append_feedback_round "$ROUND" "$REVIEWER_FEEDBACK"

  echo ""
  echo "─────────────────────────────────────────────────────────────────────"
  echo "→ Round $ROUND: Implementer addressing reviewer feedback"
  echo "─────────────────────────────────────────────────────────────────────"

  CORRECT_PROMPT="The reviewer has come back with additional feedback on your previous attempt.

CRITICAL CONTEXT — read these files at the start of this round:
1. The implementation plan at $PLAN_PATH. Re-read it so your fixes stay aligned with the overall goals.
2. The full task history at $TASK_FILE — original feedback PLUS every subsequent review round.

Address the LATEST round of feedback (Round $ROUND) while keeping every earlier concern satisfied AND staying aligned with the plan. If the new feedback contradicts earlier feedback or the plan, flag the contradiction explicitly rather than silently choosing one.

Make the necessary code edits and run any relevant tests. At the end, summarize what you changed, why, and how it aligns with the plan."

  run_codex "implement-round$ROUND" "workspace-write" "$CORRECT_PROMPT"

  CURRENT_DIFF=$(git diff "$BASELINE_REF")
  if [[ "$CURRENT_DIFF" == "$DIFF" ]]; then
    echo ""
    echo "⚠ Implementer made no new changes this round. Stopping loop."
    FINAL_VERDICT="STUCK"
    break
  fi

  ROUND=$((ROUND + 1))
done

# ── Step 4: Final report ─────────────────────────────────────────────
echo ""
echo "─────────────────────────────────────────────────────────────────────"
echo "→ Loop finished"
echo "─────────────────────────────────────────────────────────────────────"

case "$FINAL_VERDICT" in
  APPROVE)
    echo "✓ Reviewer approved after $ROUND review round(s)."
    ;;
  STUCK)
    echo "⚠ Implementer stopped making changes — review the latest output manually."
    ;;
  UNCLEAR)
    echo "⚠ Reviewer's verdict couldn't be parsed — review the log manually."
    ;;
  "")
    echo "⚠ Hit max rounds ($MAX_ROUNDS) without approval. Review changes manually."
    ;;
esac

echo ""
echo "Session artifacts:"
echo "  Plan:       $PLAN_PATH"
echo "  Task file:  $TASK_FILE"
echo "  Logs:       $LOG_DIR"
echo "  Diffs:      $SESSION_DIR/round-*.diff"
echo ""
echo "To inspect changes:"
echo "  git diff $BASELINE_REF"
echo ""
echo "When ready to commit:"
echo "  git add -A && git commit -m \"Address feedback (loop session $TIMESTAMP)\""