---
name: codenode-workflow-dsl
description: Parse, validate, and normalize language-neutral CodeNode workflow JSON and nested DSL expressions such as d[e]{c(a,b)}. Use before any Java, PowerShell, Go, or future language skill when a request contains expression, entry, environment, scope, condition, branch, nested node, or large graph data.
---

# CodeNode Workflow DSL

Normalize workflow structure before selecting a language implementation. Treat node IDs and the normalized AST as authoritative; treat names and natural-language prompts as labels and intent only.

## Workflow

1. Read the request JSON and require `schemaVersion`, `nodes`, and either `expression` or a structured workflow AST.
2. For DSL input, run:

   ```powershell
   node scripts/parse-workflow.mjs <request.json>
   ```

3. Stop on unknown IDs, duplicate IDs, malformed delimiters, disallowed cycles, excessive nesting, or invalid environment-variable definitions.
4. Use only `reachableNodeIds` and normalized `nodes` for generation. Do not send unrelated canvas nodes to a language skill.
5. Pass `ast`, `environment`, node metadata, and warnings to exactly one selected language skill.
6. Preserve control flow, input order, named ports, types, side-effect declarations, error policy, and confirmation requirements during code generation.

## Semantics

- `a`: reference node `a`.
- `c(a,b)`: call node `c` with ordered arguments `a` and `b`.
- `d[e]{c(a,b)}`: enter scope node `d`; if condition `e` is true, call `c(a,b)`.
- `d[e]{c(a,b)}else{f()}`: execute an explicit alternate branch.
- `d[e]{f[x]{c(a,b)}}`: nest scope `f` inside scope `d`.
- Separate expressions in the same body with ASCII `;`; separate arguments with ASCII `,`.

Use stable ASCII node IDs. Allow Unicode in `name`, `prompt`, and literal values, but never resolve references by display name.

## Language-neutral environment

Keep portable variables under `environment.variables`. Do not use language-specific syntax such as `$NAME`, `%NAME%`, or `System.getenv()` in the shared request.

```json
{
  "environment": {
    "variables": {
      "WORK_DIR": { "dataType": "path", "source": "literal", "value": "output" },
      "API_TOKEN": { "dataType": "string", "source": "environment", "key": "API_TOKEN", "secret": true }
    }
  }
}
```

Never place a secret value in workflow JSON. Store only its environment key or secret-provider reference. Let the selected language skill map the normalized variable to its runtime syntax.

## Required safeguards

- Default to maximum depth 32, maximum 10,000 nodes, and maximum expression length 1 MiB.
- Reject implicit cycles. Permit feedback only through an explicit `loop` node and require a termination condition.
- Distinguish absent values from explicit `null`.
- Distinguish data dependencies from control order; do not infer execution order from visual position.
- Require explicit semantics for parallelism, retries, timeout, side effects, permissions, and error handling when present.
- Keep `schemaVersion` and node implementation versions so stored workflows can be migrated.
- Ask for clarification when the prompt conflicts with the normalized graph.

Read [references/workflow-contract.md](references/workflow-contract.md) when defining schemas, adding control structures, mapping shared types, or handling large graphs.

