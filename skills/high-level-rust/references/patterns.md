# High-Level Rust Patterns

Use these templates as starting points, not mandatory framework code.

## Contents

1. [Boundary conversion](#boundary-conversion)
2. [Aggregate construction and rehydration](#aggregate-construction-and-rehydration)
3. [State and transition](#state-and-transition)
4. [Application service](#application-service)
5. [Ownership choices](#ownership-choices)
6. [Review rewrites](#review-rewrites)

## Boundary Conversion

Let boundary types mirror incoming data. Validate and convert once:

```rust
struct CreateLineDto {
    sku: String,
    quantity: u16,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
struct Quantity(u16);

impl TryFrom<u16> for Quantity {
    type Error = DomainError;

    fn try_from(value: u16) -> Result<Self, Self::Error> {
        (value > 0)
            .then_some(Self(value))
            .ok_or(DomainError::QuantityMustBePositive)
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
struct LineItem {
    sku: String,
    quantity: Quantity,
}

impl TryFrom<CreateLineDto> for LineItem {
    type Error = DomainError;

    fn try_from(dto: CreateLineDto) -> Result<Self, Self::Error> {
        Ok(Self {
            sku: dto.sku.into(),
            quantity: dto.quantity.try_into()?,
        })
    }
}
```

Keep the DTO's `String` and move it into the domain when one owner is natural. If multiple
snapshots genuinely share the text, use `Rc<str>` within one thread or `Arc<str>` only when
those snapshots cross threads.

## Aggregate Construction And Rehydration

Private scalar fields do not protect an aggregate whose public fields let callers assemble
inconsistent totals or impossible lifecycle states. Keep the aggregate closed and validate
persistence data on the way back in.

Illustrative pseudocode follows; `OrderRow`, conversions, and consistency rules are
domain-specific and intentionally omitted:

```rust
pub struct Order {
    id: OrderId,
    lines: Vec<LineItem>,
    total: Money,
    state: OrderState,
}

impl Order {
    pub fn draft(id: OrderId) -> Self {
        // Build the one valid initial shape.
    }

    pub fn try_rehydrate(row: OrderRow) -> Result<Self, DomainError> {
        let candidate = Self {
            id: row.id.try_into()?,
            lines: convert_lines(row.lines)?,
            total: row.total.try_into()?,
            state: row.state.try_into()?,
        };
        validate_consistency(&candidate)?;
        Ok(candidate)
    }

    pub fn state(&self) -> &OrderState {
        &self.state
    }
}
```

Do not expose a general unchecked constructor merely to make a repository compile. If a
trusted constructor is unavoidable, keep it `pub(crate)` and keep row validation adjacent to
it.

## State And Transition

Prefer one state variant over interacting flags:

The following fragments assume snapshots cross async worker threads, so `Arc` is deliberate.
For a single-thread runner, use `Rc` or plain owned collections instead.

```rust
use std::sync::Arc;

#[derive(Clone, Debug, PartialEq, Eq)]
enum OrderState {
    Draft { lines: Arc<Vec<LineItem>> },
    Placed {
        lines: Arc<Vec<LineItem>>,
        placed_at: u64,
    },
    Cancelled {
        lines: Arc<Vec<LineItem>>,
        reason: Arc<str>,
    },
}

#[derive(Clone, Debug, PartialEq, Eq)]
struct Order {
    id: OrderId,
    state: OrderState,
}

enum Command {
    AddLine(LineItem),
    Place { at: u64 },
    Cancel { reason: Arc<str> },
}

struct Decision {
    next: Order,
    events: Vec<Event>,
}
```

Keep the transition pure. Use copy-on-write for a fresh local update:

```rust
fn decide(order: &Order, command: Command) -> Result<Decision, DomainError> {
    match (&order.state, command) {
        (OrderState::Draft { lines }, Command::AddLine(line)) => {
            let mut next_lines = Arc::clone(lines);
            Arc::make_mut(&mut next_lines).push(line.clone());

            Ok(Decision {
                next: Order {
                    id: order.id,
                    state: OrderState::Draft { lines: next_lines },
                },
                events: vec![Event::LineAdded {
                    order_id: order.id,
                    line,
                }],
            })
        }
        (OrderState::Draft { lines }, Command::Place { at }) if !lines.is_empty() => {
            Ok(Decision {
                next: Order {
                    id: order.id,
                    state: OrderState::Placed {
                        lines: Arc::clone(lines),
                        placed_at: at,
                    },
                },
                events: vec![Event::Placed {
                    order_id: order.id,
                    at,
                }],
            })
        }
        (OrderState::Draft { .. }, Command::Place { .. }) => {
            Err(DomainError::EmptyOrderCannotBePlaced)
        }
        // Handle every remaining state/command pair explicitly.
        _ => Err(DomainError::InvalidTransition),
    }
}
```

`Arc<Vec<T>>` is suitable when snapshots are common and updates are relatively rare. Use a
plain `Vec<T>` with ownership transfer for single-owner workflows. Consider a persistent
collection only after repeated snapshot updates justify it.

## Application Service

Keep I/O in an application shell:

This fragment assumes repository and publisher substitution are real and multiple runtime
handlers share dynamically selected implementations. With one stable implementation, use a
concrete dependency and omit these `Arc<dyn Trait>` fields.

```rust
trait OrderRepository: Send + Sync {
    fn load(&self, id: OrderId) -> Result<Order, RepositoryError>;
    fn save(&self, order: Order) -> Result<(), RepositoryError>;
}

trait EventPublisher: Send + Sync {
    fn publish(&self, events: Vec<Event>) -> Result<(), PublishError>;
}

#[derive(Clone)]
struct HandleOrder {
    repository: Arc<dyn OrderRepository>,
    publisher: Arc<dyn EventPublisher>,
}

impl HandleOrder {
    fn execute(&self, id: OrderId, command: Command) -> Result<Order, AppError> {
        let current = self.repository.load(id)?;
        let Decision { next, events } = decide(&current, command)?;
        self.repository.save(next.clone())?;
        self.publisher.publish(events)?;
        Ok(next)
    }
}
```

The clone before `save` is acceptable only because `Order` was designed to clone cheap
handles. If saving can consume the only needed value, change the API to avoid the clone.
Document or fix the non-atomic save/publish sequence.

## Ownership Choices

| Need | Prefer | Avoid |
|---|---|---|
| One owner, transferable value | `String`, `Vec<T>`, owned struct | `Arc` by habit |
| Short local read | `&T` | cloning to satisfy one call |
| Single-thread sharing | `Rc<T>` | atomic refcounts without need |
| Cross-thread sharing | `Arc<T>` | borrowed lifetimes spanning tasks |
| Many immutable versions | copy-on-write or persistent collection | repeated deep clones |

Use `Arc<Mutex<T>>` only for truly shared mutable state. Keep the lock scope small and never
hold a synchronous guard across `.await`.

## Review Rewrites

### Flag soup → state enum

Replace:

```rust
struct Job {
    running: bool,
    finished: bool,
    failed: bool,
    error: Option<String>,
}
```

With:

```rust
enum JobState {
    Queued,
    Running { started_at: u64 },
    Succeeded { finished_at: u64 },
    Failed { finished_at: u64, error: String },
}
```

### Borrow graph → owned application boundary

Do not add lifetimes to a long-lived service merely to avoid one cheap shared handle:

```rust
struct Service {
    config: Arc<Config>,
}
```

Keep borrowing inside bounded calls:

```rust
fn validate(config: &Config, input: &Input) -> Result<(), ValidationError>;
```

### Trait ceremony → concrete dependency

If a service has one stable implementation and no useful substitution boundary, prefer:

```rust
struct App {
    repository: PostgresOrderRepository,
}
```

Introduce a trait when the architectural seam becomes real, not preemptively.
