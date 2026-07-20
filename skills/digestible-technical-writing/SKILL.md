---
name: digestible-technical-writing
description: Write and revise technical design documents, specifications, ADRs, implementation plans, API contracts, and review notes so they are self-contained, easy to scan, and understandable without hidden discussion context. Use when drafting a substantial technical document, reorganizing one for cohesion, explaining a complex system to reviewers, or making dense or cryptic technical prose easier to absorb while preserving its decisions and the author's voice.
---

# Digestible Technical Writing

Write for a reader who understands the domain but does not have the author's working memory, prior conversations, or unpublished assumptions.

The document should teach its own vocabulary, establish scope, and present dependent ideas in the order needed to understand them.

## Choose The Editing Mode

Use the mode requested by the user.

- **New document:** design the section order before drafting.
- **Targeted revision:** preserve the existing structure and voice; change only what is needed.
- **Cohesion rewrite:** preserve settled meaning and useful original prose, but regroup and rewrite where accumulated edits have damaged the reading order.
- **Review:** identify missing context, ambiguous terms, unexplained transitions, and conflicts before changing prose.

Do not turn a targeted edit into a full rewrite.

Do not preserve a sentence merely because it is old when it prevents the document from standing alone.

## Build The Reading Order

Before drafting, write down the document's audience, purpose, status, and scope.

Order sections by dependency rather than by the order in which decisions were discovered.

A common progression is:

1. purpose and scope;
2. whole-system overview;
3. core terms and identities;
4. relationships and ownership;
5. behavior and workflows;
6. storage or implementation detail;
7. errors, limits, and deferred work;
8. acceptance criteria or next steps.

Definitions must precede rules that depend on them.

An overview should explain how the major parts fit together before individual sections descend into schema fields, edge cases, or algorithms.

## Draft One Claim At A Time

Prefer a short paragraph that carries one main claim.

One sentence is often enough, but it is not a mechanical rule.

Keep two or three sentences together when they form one indivisible explanation.

Split a paragraph when it changes subject, moves from rule to rationale, or introduces an example.

Use lists for sibling facts, ordered steps, alternatives, fields, and acceptance conditions.

Do not use a list to disguise prose that needs a causal explanation.

## Separate Rule, Rationale, And Example

State the rule directly.

Then explain why the rule exists when the reason is not obvious.

Follow unfamiliar abstractions with a concrete example close to the first use.

Keep tradeoffs explicit: name what the design gains, what it costs, and what alternative was rejected.

For a decision that remains provisional, say what is fixed now and what is still pending.

## Make Context Local

Name the subject instead of relying on ambiguous words such as "it", "this", "that", or "the above".

Replace phrases such as "as discussed", "the previous approach", or "the usual rule" with enough local context to understand the statement.

When using a cross-reference, state why the referenced section matters.

Repeat a small amount of context when that saves the reader from reconstructing it across several sections.

Distinguish similar concepts explicitly, especially:

- identity versus address;
- ownership versus attribution;
- current state versus history;
- atomicity versus idempotency;
- logical values versus physical storage;
- implemented behavior versus intended behavior.

## Explain Technical Surfaces

For an API, explain:

- what the caller supplies;
- what the operation returns;
- when state changes;
- what is atomic;
- how references resolve;
- which errors are expected; and
- which behavior is deliberately deferred.

For a storage design, begin with a conceptual map of authoritative state, derived state, ownership, and transaction boundaries before showing tables or indexes.

For an implementation plan, state the outcome of each milestone, its dependencies, its gate, and what it intentionally does not include.

For pseudocode, distinguish explanatory labels from real identifiers and mark provisional syntax as provisional.

## Preserve Status And Scope

Present-tense requirements in a prospective specification can sound like claims about an existing implementation.

Add a clear status statement when that distinction matters.

Use consistent labels for:

- implemented;
- settled but not implemented;
- recommended;
- open;
- deferred; and
- rejected.

Do not silently promote a recommendation into a settled decision.

Do not mix current behavior and future behavior in one paragraph without naming the boundary.

## Example

Dense version:

> Batches validate under the writer reservation and retries use separate keys, with runs remaining attribution-only.

Digestible version:

> Callers assemble a mutation batch in memory. This does not open a database transaction.
>
> When `commit()` is called, the system acquires the writer reservation and validates the complete batch against one current state.
>
> A run ID groups operations for attribution. A separate idempotency key identifies a retry of the same logical batch.

The expanded version is longer, but each term is introduced where the reader needs it and each paragraph answers one question.

## Final Cold Read

Read the complete document from the perspective of someone who did not participate in its creation.

Check that:

- the opening states purpose, audience, status, and scope;
- the whole-system shape appears before detailed machinery;
- every specialized term is defined before dependent use;
- pronouns and shorthand have clear antecedents;
- examples match the normative rules;
- status and deferral language is consistent;
- cross-references include local meaning;
- no section assumes review-thread knowledge;
- paragraphs remain readable without becoming choppy; and
- the conclusion or next action follows from the document.

Fix the smallest structural or prose issue that resolves each failure.

Do not compress the final pass merely to reduce line count.
