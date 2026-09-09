---
name: using-superpowers
description: Use when starting a conversation or task where an available skill may apply
---

# Using Superpowers

Before the first response or action, inspect the available skills and read every
skill named by the user or clearly applicable to the task. Announce the skills
being used. Follow them in priority order: process skills first, then domain
skills. A skill is clearly applicable only when its stated trigger matches the
current requested action; tangential subject overlap is not a trigger.

Scale the workflow and verification to the task's risk. A read-only answer,
status check, or explanation does not require design ceremony. An approved,
narrow fix may proceed through systematic debugging and test-driven development.
Materially new behavior, architecture, workflow, or UI requires brainstorming.

## Invariants

- User instructions decide outcomes and scope and override workflow guidance;
  system requirements and the safety invariants in this section remain binding.
- Preserve root-cause diagnosis, isolation for risky work, approval before
  destructive or scope-expanding action, proportional tests, review, and fresh
  evidence before completion claims.
- End verification when fresh evidence satisfies the approved task. More checks
  require a new risk, failure, or uncertainty.

Do not repeat an equivalent command, test, hypothesis, or blocker report without new evidence or a relevant state change. After three materially equivalent failed attempts, stop the current turn, preserve state, and report the blocker and evidence. Do not stop the host application or destroy the session.

Attempts are materially equivalent when their relevant inputs, preconditions,
and expected result have not changed. New evidence must change the next decision;
relabeling the same output or starting a new turn, agent, or resumed session does
not reset a known count.
At the boundary, record the operation signature, count, failure evidence, and
current state in the available durable task handoff; a successor consults that
record before retrying. If no durable handoff exists, include them in the blocker
report so the conversation remains the record.

## Common mistakes

Do not treat skill use as permission to broaden scope, repeat unchanged work, or
replace a user's explicit decision with process ceremony.
