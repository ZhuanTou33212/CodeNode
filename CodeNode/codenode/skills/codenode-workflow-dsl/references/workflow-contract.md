# CodeNode language-neutral workflow contract

## Contents

1. Canonical request
2. DSL grammar
3. Node and port rules
4. Shared data types and variables
5. Control flow and execution policy
6. Large graphs and validation
7. Language handoff

## Canonical request

```json
{
  "schemaVersion": "2.0",
  "requestId": "request-1",
  "action": "build-program",
  "language": "go",
  "entry": "d",
  "expression": "d[e]{c(a,b)}",
  "environment": {
    "variables": {
      "WORK_DIR": {
        "dataType": "path",
        "source": "literal",
        "value": "output"
      }
    }
  },
  "nodes": [
    { "id": "a", "type": "constant", "value": 10, "outputs": [{ "id": "value", "dataType": "integer" }] },
    { "id": "b", "type": "constant", "value": 20, "outputs": [{ "id": "value", "dataType": "integer" }] },
    { "id": "c", "type": "operation", "operation": "add", "inputs": [{ "id": "left", "dataType": "integer" }, { "id": "right", "dataType": "integer" }] },
    { "id": "d", "type": "scope", "scopeType": "if" },
    { "id": "e", "type": "condition", "outputs": [{ "id": "result", "dataType": "boolean" }] }
  ],
  "requiresConfirmation": true
}
```

`expression` defines control structure and ordered calls. `nodes` defines reusable node metadata and implementations. Never duplicate full node objects inside the expression tree.

## DSL grammar

```text
workflow   := expression (";" expression)*
expression := identifier
            | identifier "(" arguments? ")"
            | identifier "[" expression "]" "{" workflow? "}" ("else" "{" workflow? "}")?
arguments  := expression ("," expression)*
identifier := ASCII letter/digit/underscore followed by ASCII letters, digits, `_`, `-`, `.`, `:`, or `/`
```

Delimiters are structural and cannot appear in IDs. Display names may contain any Unicode text. Add quoting and escaping only through a future schema version; do not improvise escaping in version 2.0.

## Node and port rules

- Keep `id` stable and unique. Renaming `name` must not change references.
- Give each input and output port a stable `id`, `dataType`, and `required` flag.
- Preserve argument order for positional inputs. Prefer named port bindings when nodes can evolve.
- Represent a reused node once and refer to its ID from multiple calls.
- Separate data edges from control order. Visual coordinates are never execution semantics.
- Declare purity and side effects with fields such as `effect: "pure"`, `effect: "filesystem"`, or `effect: "network"`.
- Declare `idempotent`, `timeoutMs`, `retry`, `permissions`, and `errorPolicy` when they affect execution.

## Shared data types and variables

Use these portable base types: `boolean`, `integer`, `number`, `string`, `bytes`, `path`, `datetime`, `duration`, `object`, `any`. Compose collections as `list<T>`, `set<T>`, `map<K,V>`, and nullable values as `optional<T>`.

Use `environment.variables` as a map keyed by portable uppercase identifiers. Each definition has:

- `dataType`: portable type.
- `source`: `literal`, `environment`, or `node`.
- `value`: required only for non-secret `literal` values.
- `key`: required for `environment` sources.
- `nodeId` and optional `portId`: required for `node` sources.
- `secret`: mark sensitive references; never include their resolved value.
- `scope`: optional `workflow`, `scope`, or `node`; default `workflow`.

Language skills map variables after normalization:

| Neutral source | Java | PowerShell | Go |
| --- | --- | --- | --- |
| environment | `System.getenv("KEY")` | `$env:KEY` | `os.Getenv("KEY")` |
| literal | typed local/final value | typed/local variable | typed variable/constant |
| node | referenced output value | referenced output value | referenced output value |

## Control flow and execution policy

- `scopeType: "if"` requires a boolean condition and may have an `else` body.
- Add loops as explicit scope nodes with termination, iteration limit, and feedback bindings. Never interpret an arbitrary graph cycle as a loop.
- Add parallel execution explicitly with a `parallel` scope and a join/error policy.
- Define failures as `stop`, `continue`, `fallback`, or `retry`; do not let a language backend choose silently.
- Keep build-time confirmation distinct from runtime permission checks.
- Preserve deterministic ordering unless a parallel scope explicitly relaxes it.

## Large graphs and validation

- Parse no deeper than 32 nested expressions by default.
- Reject requests larger than 10,000 nodes or expressions larger than 1 MiB by default.
- Build an ID index in linear time and resolve by ID, never by repeated name search.
- Send only the subgraph reachable from `entry` and its data dependencies to the language skill.
- Reject duplicate IDs, missing references, invalid portable variable names, and implicit cycles.
- Preserve hashes or implementation versions for reusable nodes so cached generation is invalidated correctly.
- Split independent roots into separate build units when the reachable subgraph is too large for the active model context.

## Language handoff

The normalized handoff contains `ast`, `reachableNodeIds`, filtered `nodes`, `environment`, and validation warnings. A language skill must not reinterpret the original DSL differently. If a backend cannot express a normalized feature, report the unsupported feature instead of dropping it.

