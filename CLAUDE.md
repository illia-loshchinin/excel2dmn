# User preferences

- Subagents that only execute work without needing judgment (applying already-decided
  fixes, mechanical edits, running checks, reconstructing files) run on Sonnet: pass
  `model: "sonnet"` to the Agent tool. Agents that must reason (reviewers, skeptics,
  design/planning) keep the default model.
