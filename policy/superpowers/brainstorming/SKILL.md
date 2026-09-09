---
name: brainstorming
description: Use when materially new behavior, architecture, workflows, or UI require design decisions
---

# Brainstorming

Use brainstorming when the user is asking for a material product or engineering
decision: new behavior, architecture, workflow, data flow, or UI. Understand the
context, clarify unresolved requirements, compare viable approaches, present a
right-sized design, obtain approval, record the approved design, and then create
an implementation plan.

A read-only answer, status check, or diagnosis does not require design ceremony.
Do not invoke it for execution of an approved plan or a narrow fix whose outcome
and boundaries are already approved. For an approved narrow bug fix, use
systematic debugging and test-driven development directly. File size is not the
test: brainstorm whenever a material product or architecture decision remains
unresolved.

## Quick classification

| Observable condition | Process |
|---|---|
| Expected behavior and boundaries are explicit; no new interface, persistence, security, or lifecycle decision | Debug and test directly |
| External behavior for multiple users changes, or an interface, persistence, security, lifecycle, or trade-off remains undecided | Brainstorm and obtain approval |
| Read-only answer, status, or diagnosis | Inspect and report proportionally |

Keep design artifacts proportional: a material but compact decision can have a
compact design and plan.

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

Do not equate "small" with "non-material," or "implementation requested" with
approval for unresolved behavior. Conversely, do not demand a second design when
the user has already approved the material choices.
