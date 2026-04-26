#!/usr/bin/env bash
# address-feedback.sh — Paste feedback from ChatGPT Pro, spawn Codex to address it
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
echo "→ Sending to Codex (gpt-5.5, xhigh reasoning)..."
echo ""

codex exec \
  -m gpt-5.5 \
  -c model_reasoning_effort=xhigh \
  -c hide_agent_reasoning=false \
  -c show_raw_agent_reasoning=true \
  -c hide_command_output=false \
  --sandbox workspace-write \
  "A senior reviewer (ChatGPT Pro) provided the following feedback on recent changes in this repo. Address every concern they raised. Make the necessary code edits, run any relevant tests, and summarize what you changed and why at the end.

If any feedback is ambiguous or conflicts with the existing code, flag it explicitly rather than guessing.

Output style:
- Show your reasoning verbosely as you work through the feedback.
- State which commands you're running and why before running them.
- When reading files, briefly summarize what you found (1-2 sentences) rather than echoing chunks of the file content. Only quote specific lines when directly discussing them.
- At the end, give a clean summary of what changed and why.

Reviewer feedback:
───
$FEEDBACK
───"