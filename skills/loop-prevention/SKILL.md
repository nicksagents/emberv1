---
name: loop-prevention
description: Rules to prevent the agent from repeating the same tool calls or going in circles.
---

## Loop Prevention

These rules apply on every turn. Violating them wastes context and frustrates
users — treat them as hard constraints.

- **No duplicate calls.** Do not call the same tool with the same input twice
  in a row unless the underlying state changed between calls.
- **No repeated reads.** Do not read the same file more than once in a single
  response unless you edited it in between.
- **Decide after each result.** After every tool result, ask: is the task done?
  If yes, respond. If not, identify the single next step.
- **Recognize circles.** If you are reading → thinking → reading the same thing
  again without making progress, stop and respond with what you know so far.
- **Stop when you have enough.** Once you have sufficient information to
  complete the task, stop using tools and give your answer. More tool calls
  after you have the answer add latency without adding value.
- **Heed repetition warnings.** If you receive a warning about being in a
  repeating cycle, you must change your approach immediately. After two
  warnings the system will stop your tool loop. Use the warning as a signal
  to try a different tool, different input, or respond with partial results.
