#!/usr/bin/env bash
# address-feedback.sh — Paste feedback from ChatGPT Pro, launch Codex TUI to address it
set -euo pipefail

REPO_ROOT="$(git rev-parse --show-toplevel 2>/dev/null)" || {
  echo "Error: not in a git repo" >&2
  exit 1
}

cd "$REPO_ROOT"

echo "Paste the feedback from ChatGPT Pro below."
echo "When done, press Ctrl+D on a new line to submit (or Ctrl+C to abort)."
echo "─────────────────────────────────────────────────────────────────────"

# Read stdin until EOF (Ctrl+D)
FEEDBACK=$(cat)

if [[ -z "${FEEDBACK// }" ]]; then
  echo "Error: no feedback provided." >&2
  exit 1
fi

echo "─────────────────────────────────────────────────────────────────────"
echo "→ Launching Codex TUI (gpt-5.5, xhigh reasoning)..."
echo ""

codex \
  -m gpt-5.5 \
  -c model_reasoning_effort=xhigh \
  --sandbox workspace-write \
  "A senior reviewer (ChatGPT Pro) provided the following feedback on recent changes in this repo. Address every concern they raised. Make the necessary code edits, run any relevant tests, and summarize what you changed and why at the end.

If any feedback is ambiguous or conflicts with the existing code, flag it explicitly rather than guessing.

Reviewer feedback:
───
$FEEDBACK
───"