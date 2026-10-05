# Workspace rules

## Sub-agents
- ALWAYS run research / review / adversarial (ATTACKER) / benchmark sub-agents on **Sonnet 5.5 at high effort**.
  - Use the agent definitions in `.claude/agents/` (`researcher`, `attacker`), which pin `model: sonnet` and `effort: high`.
  - If spawning a generic agent instead, pass `model: "sonnet"` explicitly.
- NEVER dispatch ATTACKER rounds without asking the user first; they will say when to dispatch.
  Before the first attacker round: open the draft PR and produce a PDF run-down explainer.
