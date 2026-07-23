---
name: high-level-rust
description: Design, implement, refactor, and review application-layer Rust using type-first domains, a functional core with impure adapters, and deliberate ownership choices that reduce lifetime plumbing without cargo-cult cloning. Use for Rust web APIs, CRUD or business services, workflows and state machines, repositories and adapters, DDD or hexagonal Rust, requests for "high-level Rust" or functional Rust, and borrow-checker friction spanning application layers. Do not apply it as a blanket style to kernels, parsers, codecs, games, tight loops, or other measured hot paths.
---

# High-Level Rust

Treat “high-level” as an application architecture and ownership policy, not a Rust
dialect. Preserve Rust's type and concurrency checks while spending cheap shared ownership
only where it materially simplifies application boundaries.

## Classify The Code

Choose the style by workload:

- Use it as a default for I/O-heavy application code and business-rule-heavy domains.
- Use ordinary ownership, borrowing, and mutation for CPU-bound or allocation-sensitive
  paths.
- In mixed systems, keep high-level boundaries around the domain and isolate optimized
  kernels behind narrow APIs.

Do not quote a universal performance penalty. Measure the actual workload.

## Build In Five Passes

### 1. Separate Boundary Data From Domain Data

Keep transport and persistence types honest about their source format. A request DTO or
database row may use `String`, `Vec`, optional fields, and weak primitives because it is
short-lived and usually consumed once.

Convert at the boundary into domain types:

- Validate constrained scalars through private fields and fallible constructors.
- Use data-carrying enums for mutually exclusive states.
- Encode structural invariants in types.
- Return explicit `Result` errors for rules that depend on runtime state.

Do not wrap every scalar. Add a domain type only when it enforces meaning, prevents mixing
identities or units, or centralizes validation.

Protect aggregate invariants as well as leaf values. Keep aggregate fields private (or
`pub(crate)` inside a deliberate trust boundary) when a public struct literal could fabricate
a state that normal transitions forbid. Expose read-only accessors and named constructors.
Treat database rows as boundary data: convert them through fallible rehydration that checks
cross-field facts such as totals, non-empty submitted collections, and valid state-specific
data before returning a domain aggregate.

### 2. Shape A Functional Core

Express business decisions as pure transformations where practical:

```rust
fn decide(
    current: &State,
    command: Command,
) -> Result<Decision, DomainError>;
```

Make `Decision` own its next state and domain events. Keep database, clock, network, and
queue access outside this function.

Allow local mutation of freshly owned or freshly cloned values. Avoid shared observable
mutation escaping from the domain operation. Use exhaustive matches so new enum variants
force transition logic to be reconsidered.

### 3. Choose Ownership In This Order

1. Move a value when ownership naturally transfers.
2. Borrow with `&T` or `&mut T` for local, bounded access.
3. Copy small `Copy` values.
4. Use `Rc<T>` for real single-thread shared ownership or `Arc<T>` for real cross-thread
   shared ownership.
5. Use persistent collections or copy-on-write only when the application needs multiple
   cheap snapshots.

Keep `String` and `Vec<T>` when one owner is natural. Do not put primitives, small values,
or every nested struct behind `Arc` mechanically.

Choose `Rc` versus `Arc` from the actual thread boundary, not from familiarity or a
hypothetical future adapter. A synchronous single-thread runner should normally keep owned
values or use `Rc`; an async service may justify `Arc` when values cross spawned tasks or its
public API intentionally needs `Send + Sync`. State that reason when choosing atomic
reference counting.

Treat every clone as a cost with a known mechanism:

- `Arc::clone` and `Rc::clone` increment reference counts.
- `String::clone`, `Vec::clone`, and ordinary nested clones may copy and allocate.
- Persistent-collection clones share structure but make updates and dependencies costlier.

Do not add `LightClone` automatically. If a project opts into a cheap-clone marker crate,
inspect its supported versions and implementations, and treat it as a review guardrail
rather than proof.

### 4. Put I/O At Deliberate Seams

Arrange application flow as impure input → pure decision → impure output.

Introduce a trait for a repository, publisher, clock, or external client only when the seam
has real substitution, testing, plugin, or architectural value. Prefer a concrete type when
there is one stable implementation.

Choose the dependency form deliberately:

- Use a concrete field for the simplest closed design.
- Use a generic parameter for static substitution when type propagation is acceptable.
- Use `Arc<dyn Trait + Send + Sync>` for an owned, shared, dynamically selected dependency.

Create dependencies at the composition root. Do not create infrastructure clients inside
domain functions.

State transaction boundaries explicitly. A successful database write followed by a failed
event publish is not atomic; use an outbox, a shared transaction, retries with idempotency,
or a documented failure policy.

### 5. Verify The Design

Test the properties the architecture is meant to buy:

- Invalid scalar construction and structurally impossible states.
- Invalid transport or persistence snapshots failing rehydration before entering the domain.
- Allowed and rejected state transitions.
- Old snapshots remaining unchanged after pure decisions.
- Application orchestration with lightweight adapters or fakes.
- Allocation or throughput behavior when clones occur over large data or inside loops.

For implementation work, run the repository's formatter, tests, and strict lints. Inspect
clone-heavy paths rather than assuming application code is too slow or that reference
counting is free.

Keep delivered Rust examples compilable. If brevity requires omitted types, conversions,
or match arms, label the block as pseudocode and name the omissions instead of presenting an
almost-compiling snippet.

## Review Existing Code Without Rewriting Everything

Preserve sound existing architecture. Target the specific source of friction:

- Replace flag-and-`Option` state soup with an enum.
- Shorten a borrow graph by moving ownership or sharing one stable value.
- Extract pure decision logic from a handler containing both I/O and rules.
- Remove a trait or `Arc` that has no substitution or sharing purpose.
- Optimize a measured clone-heavy path without spreading lifetime complexity outward.

Explain each change in terms of the invariant, ownership relationship, or measured cost it
improves.

## Async And Concurrency Guardrails

Require `Send + Sync` only where the runtime or sharing boundary requires it. Remember that
`Arc<T>` shares ownership; it does not make `T` internally thread-safe.

Do not hold a synchronous mutex guard across `.await`. Prefer transaction-local ownership,
message passing, an async-aware lock when genuinely required, or a narrower critical
section.

Treat async trait-object design as its own tradeoff. Follow the project's existing boxed
future or macro convention instead of introducing one solely for stylistic uniformity.

## Concrete Patterns

Read [references/patterns.md](references/patterns.md) when writing a new domain model,
transition function, or application service, or when comparing ownership options. The
reference contains compact templates and anti-pattern rewrites; do not load it for a simple
conceptual answer.
