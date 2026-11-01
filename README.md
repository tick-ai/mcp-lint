# mcp-lint: check an MCP server's tool list before it ships

We publish tools for agents through MCP. When a tool's description is vague or its
schema is wrong, the agent guesses. This job: write a linter that reads a tool list and
says what is wrong, before we ship.

## Files and territory

Create exactly one file: `mcp-lint.mjs`, at the root of this repository.
**Only the paths named here as the territory may change: the territory is `mcp-lint.mjs`.**
Do not change or add any other file (not this README, not `package.json`, nothing else).

Constraints: Node 22 and nothing installed. `mcp-lint.mjs` is an ES module that imports
only Node built-in modules (`node:fs`, `node:process`, ...). No dependencies, no network,
no git. It is checked in a bare `node:22-slim` container.

## How it is run

    node mcp-lint.mjs [--strict] [--json] [--max-tokens N] <file>

Exactly one `<file>`; the options may come before or after it. `--max-tokens` takes the
next argument as its value (`--max-tokens 500`; the `--max-tokens=500` form is not needed).

* `--strict`: warnings also make the exit code 1.
* `--json`: print JSON (below) instead of text lines.
* `--max-tokens N`: the size limit for the size warning. `N` is a positive integer
  (decimal digits only, at least 1). Default 10000.

Exit codes: **1** if there is at least one error; **1** if `--strict` is given and there is
at least one warning; otherwise **0**. Usage mistakes exit **2**, print a short usage
message to stderr and nothing to stdout: no `<file>`, more than one `<file>`, an
unknown option (any other argument starting with `-`), `--max-tokens` without a value or with a value that is not a
positive integer. The program never throws on bad input, never prints a stack trace,
and only ever exits 0, 1 or 2.

## What it reads

`<file>` is read as UTF-8 (a leading byte-order mark is ignored) and must be JSON. It is
one of:

1. a plain array of tools;
2. an object with a `tools` array (the result of `tools/list`; other keys such as
   `nextCursor` are ignored);
3. an object with no `tools` array of its own but a `result` object that has a `tools`
   array (a whole JSON-RPC response).

An empty array of tools is fine (no problems). Anything else is a problem of the whole
file, and then nothing else is checked:

* the file cannot be read (missing, a directory, ...): rule `file-unreadable`, an error;
* the text is not JSON (an empty file included): rule `not-json`, an error;
* it is JSON but not one of the three shapes: rule `bad-shape`, an error.

Each such case is exactly one error, with a clear human message (never empty).

## Problems

Every problem has a **level** (`error` or `warning`), a **rule** (a fixed name below), a
**tool**, a **property** and a **message** (free text, never empty, says what is wrong).

Tool label: the tool's `name` when that is a non-empty string, otherwise `tools[i]` where
`i` is the tool's zero-based index in the list. A tool entry that is not a JSON object
(for instance `null` or a string) gets only `name-missing` and nothing else.

Location, as printed: the tool label, then `.` and the property when there is a property.
Whole-file problems have location `(file)`, the list-size problem has location `(list)`.
In JSON, `tool` and `property` are strings or `null` and `location` is the same string
that is printed.

### Errors

| rule | when | tool | property |
|---|---|---|---|
| `name-missing` | `name` is absent, not a string, or the empty string | `tools[i]` | none |
| `name-invalid` | `name` is a non-empty string that does not match `^[A-Za-z0-9_.-]{1,128}$` | the name | none |
| `name-duplicate` | a valid-or-invalid non-empty name that already appeared on an earlier tool; one error for each later occurrence | the name | none |
| `description-missing` | `description` absent, not a string, or only whitespace | label | none |
| `input-schema-invalid` | `inputSchema` is absent, is not a JSON object, has `type` other than the string `"object"` (absent counts as other), has a `properties` that is present but not an object, or a `required` that is present but not an array of strings | label | `inputSchema` |
| `required-not-in-properties` | an entry of `inputSchema.required` that is not an own key of `inputSchema.properties` (no `properties` counts as empty); one error per such entry | label | the entry |
| `output-schema-invalid` | `outputSchema` is present (even as `null`) but is not a JSON object with `"type": "object"`, or has `properties` / `required` of the wrong kind as above | label | `outputSchema` |
| `output-required-not-in-properties` | the same as `required-not-in-properties`, for `outputSchema` | label | `outputSchema.` followed by the entry |
| `default-type-mismatch` | a property of `inputSchema.properties` has an own `default` (a `null` default counts) and a `type` and the default is not of that type | label | the property name |
| `enum-duplicate` | a property of `inputSchema.properties` has an `enum` array with two equal values; one error per property | label | the property name |

Notes on the rules:

* A name that is invalid and also repeated gets both `name-invalid` and `name-duplicate`.
  Duplicates are by exact string equality. Names such as `constructor` or `__proto__` are
  ordinary names (and `required` entries and `properties` keys are compared as own keys
  only: `"required": ["constructor"]` with no such property is an error).
* A tool with a missing name is still checked for everything else, under `tools[i]`.
* `required-not-in-properties` / `default-type-mismatch` / `enum-duplicate` /
  `property-description-missing` are only checked when the schema is valid by
  `input-schema-invalid` (so an invalid schema gives only that one error). The
  `output-` rules likewise only when `outputSchema` is valid. When `outputSchema` is
  absent nothing is said about it.
* `type` in `default-type-mismatch` is a string or an array of strings naming JSON
  types: `string`, `number` (any JSON number), `integer` (a JSON number with no fractional
  part, so `1` and `1.0`), `boolean`, `null`, `array`, `object` (a non-null non-array
  object). With an array of types the default must match at least one. If `type` is
  absent, or holds anything else (an unknown type name, a non-string), nothing is said.
  A property whose own schema is not an object is not checked by this rule or by
  `enum-duplicate`.
* Equality for `enum-duplicate` is deep JSON equality: `1` and `"1"` differ, `1` and `1.0`
  are the same, objects are equal when they have the same keys with equal values in any
  key order, arrays when they are equal element by element.
* Only the top-level properties of `inputSchema` are looked at by `default-type-mismatch`,
  `enum-duplicate` and `property-description-missing`. Nested schemas (inside `items` or
  inside a property's own `properties`) are not examined. `outputSchema` properties are
  looked at only by `output-required-not-in-properties`.

### Warnings

| rule | when | tool | property |
|---|---|---|---|
| `description-short` | `description` is a string whose trimmed length is non-zero and under 20 characters (JavaScript string length) | label | none |
| `description-repeats-name` | the tool has a string name and description, and after lower-casing and removing every character that is not `a-z` or `0-9` from both, the two are equal and non-empty (`Get user` repeats `get_user`) | label | none |
| `property-description-missing` | a property of `inputSchema.properties` has no `description`, or one that is not a string or only whitespace | label | the property name |
| `list-too-large` | the size of the whole list in tokens is greater than the limit | none | none |

Size in tokens: take the array of tools (item 1 as is, or the `tools` array of 2 or 3),
write it with `JSON.stringify(tools)` (compact, no spacing), count its characters
(JavaScript string length), and the tokens are that count divided by 4, rounded up. The
limit is `--max-tokens`, default 10000. Equal to the limit is fine; one over warns. It is
checked only when the tools were read.

## Output

Text (default), on stdout, one problem per line, in the order of the tools in the list
(the order inside one tool is not fixed), then the list-size warning if any, then the
count line last:

    <file>: <level>: <location>: <message>
    ...
    <E> errors, <W> warnings

`<file>` is the path exactly as given on the command line. The count line always uses the
words `errors` and `warnings` (so `1 errors, 0 warnings`) and is printed even with no
problem. Nothing else is printed to stdout.

`--json`: stdout is one JSON object and nothing else (a final newline is fine), in place
of the text lines and count line:

    {"file": "<path as given>",
     "problems": [{"level": "error", "rule": "name-missing", "tool": "tools[0]",
                   "property": null, "location": "tools[0]", "message": "..."}, ...],
     "errors": <number>, "warnings": <number>,
     "tokens": <the size in tokens, or null when the tools were not read>}

`problems` is in the same order as the text lines. The exit code is the same with and
without `--json`.
