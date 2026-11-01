#!/usr/bin/env node
// mcp-lint: checks an MCP server's tool list before it ships. Node built-ins only.

import { readFileSync } from 'node:fs';

const USAGE = 'usage: node mcp-lint.mjs [--strict] [--json] [--max-tokens N] <file>';
const NAME_PATTERN = /^[A-Za-z0-9_.-]{1,128}$/;

class UsageError extends Error {}

const hasOwn = (object, key) => Object.prototype.hasOwnProperty.call(object, key);
const isObject = (value) => typeof value === 'object' && value !== null && !Array.isArray(value);

// ---------------------------------------------------------------- arguments

function parseArguments(argv) {
  const options = { strict: false, json: false, maxTokens: 10000, files: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--strict') {
      options.strict = true;
    } else if (arg === '--json') {
      options.json = true;
    } else if (arg === '--max-tokens') {
      i += 1;
      if (i >= argv.length) throw new UsageError('--max-tokens needs a value');
      const value = argv[i];
      if (!/^[0-9]+$/.test(value) || Number(value) < 1) {
        throw new UsageError(`--max-tokens needs a positive integer, not ${JSON.stringify(value)}`);
      }
      options.maxTokens = Number(value);
    } else if (arg.startsWith('-')) {
      throw new UsageError(`unknown option: ${arg}`);
    } else {
      options.files.push(arg);
    }
  }
  if (options.files.length === 0) throw new UsageError('no file given');
  if (options.files.length > 1) throw new UsageError('more than one file given');
  options.file = options.files[0];
  return options;
}

// ----------------------------------------------------------------- problems

function makeProblems() {
  const list = [];
  const add = (level, rule, tool, property, message) => {
    const location = tool === null ? (property === null ? '' : property) : property === null ? tool : `${tool}.${property}`;
    list.push({ level, rule, tool, property, location, message });
  };
  return { list, add };
}

/** A text that is the same for deeply equal JSON values (object keys in any order). */
function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (isObject(value)) {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}

function hasDuplicate(values) {
  const seen = new Set();
  for (const value of values) {
    const key = canonical(value);
    if (seen.has(key)) return true;
    seen.add(key);
  }
  return false;
}

const TYPE_TESTS = {
  string: (v) => typeof v === 'string',
  number: (v) => typeof v === 'number',
  integer: (v) => typeof v === 'number' && Number.isInteger(v),
  boolean: (v) => typeof v === 'boolean',
  null: (v) => v === null,
  array: (v) => Array.isArray(v),
  object: (v) => isObject(v),
};

/** True, false, or null when the declared type says nothing we can check. */
function matchesType(type, value) {
  const types = Array.isArray(type) ? type : [type];
  if (!types.every((t) => typeof t === 'string' && hasOwn(TYPE_TESTS, t))) return null;
  return types.some((t) => TYPE_TESTS[t](value));
}

/** Whether a schema is an object of type "object" with properties / required of the right kind. */
function schemaIsValid(schema) {
  if (!isObject(schema)) return false;
  if (!hasOwn(schema, 'type') || schema.type !== 'object') return false;
  if (hasOwn(schema, 'properties') && !isObject(schema.properties)) return false;
  if (hasOwn(schema, 'required')) {
    if (!Array.isArray(schema.required) || !schema.required.every((entry) => typeof entry === 'string')) return false;
  }
  return true;
}

const ownProperties = (schema) => (hasOwn(schema, 'properties') ? schema.properties : {});
const requiredOf = (schema) => (hasOwn(schema, 'required') ? schema.required : []);

function lintTool(tool, index, seen, add) {
  const fallback = `tools[${index}]`;
  if (!isObject(tool)) {
    add('error', 'name-missing', fallback, null, `tool ${fallback} is not an object, so it has no name`);
    return;
  }

  const hasName = typeof tool.name === 'string' && tool.name !== '';
  const label = hasName ? tool.name : fallback;
  if (!hasName) {
    add('error', 'name-missing', label, null, 'the tool has no name: "name" must be a non-empty string');
  } else {
    if (!NAME_PATTERN.test(tool.name)) {
      add('error', 'name-invalid', label, null, `the name ${JSON.stringify(tool.name)} must be 1 to 128 characters of letters, digits, "_", "." or "-"`);
    }
    if (seen.has(tool.name)) {
      add('error', 'name-duplicate', label, null, `the name ${JSON.stringify(tool.name)} is already used by an earlier tool`);
    }
    seen.add(tool.name);
  }

  const description = tool.description;
  if (typeof description !== 'string' || description.trim() === '') {
    add('error', 'description-missing', label, null, 'the tool has no description: "description" must be a non-blank string');
  } else if (description.trim().length < 20) {
    add('warning', 'description-short', label, null, `the description is only ${description.trim().length} characters; use at least 20 so an agent knows when to use the tool`);
  }
  if (hasName && typeof description === 'string') {
    const squash = (text) => text.toLowerCase().replace(/[^a-z0-9]/g, '');
    const flat = squash(description);
    if (flat !== '' && flat === squash(tool.name)) {
      add('warning', 'description-repeats-name', label, null, 'the description only repeats the name of the tool');
    }
  }

  // Input schema.
  const input = tool.inputSchema;
  if (!hasOwn(tool, 'inputSchema') || !schemaIsValid(input)) {
    add('error', 'input-schema-invalid', label, 'inputSchema', 'inputSchema must be an object with "type": "object", "properties" an object and "required" an array of strings');
  } else {
    const properties = ownProperties(input);
    for (const entry of requiredOf(input)) {
      if (!hasOwn(properties, entry)) {
        add('error', 'required-not-in-properties', label, entry, `${JSON.stringify(entry)} is required but is not one of the properties`);
      }
    }
    for (const key of Object.keys(properties)) {
      const property = properties[key];
      if (isObject(property)) {
        if (hasOwn(property, 'default') && hasOwn(property, 'type') && matchesType(property.type, property.default) === false) {
          add('error', 'default-type-mismatch', label, key, `the default of ${JSON.stringify(key)} does not match its type ${JSON.stringify(property.type)}`);
        }
        if (hasOwn(property, 'enum') && Array.isArray(property.enum) && hasDuplicate(property.enum)) {
          add('error', 'enum-duplicate', label, key, `the enum of ${JSON.stringify(key)} lists the same value twice`);
        }
      }
      const text = isObject(property) ? property.description : undefined;
      if (typeof text !== 'string' || text.trim() === '') {
        add('warning', 'property-description-missing', label, key, `the property ${JSON.stringify(key)} has no description`);
      }
    }
  }

  // Output schema.
  if (hasOwn(tool, 'outputSchema')) {
    const output = tool.outputSchema;
    if (!schemaIsValid(output)) {
      add('error', 'output-schema-invalid', label, 'outputSchema', 'outputSchema must be an object with "type": "object", "properties" an object and "required" an array of strings');
    } else {
      const properties = ownProperties(output);
      for (const entry of requiredOf(output)) {
        if (!hasOwn(properties, entry)) {
          add('error', 'output-required-not-in-properties', label, `outputSchema.${entry}`, `${JSON.stringify(entry)} is required in outputSchema but is not one of its properties`);
        }
      }
    }
  }
}

// -------------------------------------------------------------------- file

function toolsOf(data) {
  if (Array.isArray(data)) return data;
  if (!isObject(data)) return null;
  if (hasOwn(data, 'tools') && Array.isArray(data.tools)) return data.tools;
  if (hasOwn(data, 'result') && isObject(data.result) && hasOwn(data.result, 'tools') && Array.isArray(data.result.tools)) {
    return data.result.tools;
  }
  return null;
}

function lintFile(options) {
  const { list, add } = makeProblems();
  const wholeFile = (rule, message) => {
    add('error', rule, null, null, message);
    list[list.length - 1].location = '(file)';
    return { problems: list, tokens: null };
  };

  let bytes;
  try {
    bytes = readFileSync(options.file);
  } catch (error) {
    return wholeFile('file-unreadable', `cannot read ${options.file}: ${error.code ?? error.message}`);
  }
  let text = bytes.toString('utf8');
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
  let data;
  try {
    data = JSON.parse(text);
  } catch (error) {
    return wholeFile('not-json', `the file is not valid JSON${text.trim() === '' ? ' (it is empty)' : `: ${error.message}`}`);
  }
  const tools = toolsOf(data);
  if (tools === null) {
    return wholeFile('bad-shape', 'the JSON is not a tool list: expected an array of tools, an object with a "tools" array, or a JSON-RPC response whose "result" has a "tools" array');
  }

  const seen = new Set();
  tools.forEach((tool, index) => lintTool(tool, index, seen, add));

  const tokens = Math.ceil(JSON.stringify(tools).length / 4);
  if (tokens > options.maxTokens) {
    add('warning', 'list-too-large', null, null, `the tool list is about ${tokens} tokens, over the limit of ${options.maxTokens}`);
    list[list.length - 1].location = '(list)';
  }
  return { problems: list, tokens };
}

// -------------------------------------------------------------------- main

function run(argv) {
  let options;
  try {
    options = parseArguments(argv);
  } catch (error) {
    if (!(error instanceof UsageError)) throw error;
    process.stderr.write(`mcp-lint: ${error.message}\n${USAGE}\n`);
    return 2;
  }

  const { problems, tokens } = lintFile(options);
  const errors = problems.filter((p) => p.level === 'error').length;
  const warnings = problems.length - errors;

  if (options.json) {
    process.stdout.write(`${JSON.stringify({ file: options.file, problems, errors, warnings, tokens })}\n`);
  } else {
    const lines = problems.map((p) => `${options.file}: ${p.level}: ${p.location}: ${p.message}`);
    lines.push(`${errors} errors, ${warnings} warnings`);
    process.stdout.write(`${lines.join('\n')}\n`);
  }
  return errors > 0 || (options.strict && warnings > 0) ? 1 : 0;
}

let code;
try {
  code = run(process.argv.slice(2));
} catch (error) {
  process.stderr.write(`mcp-lint: internal error: ${error?.message ?? error}\n`);
  code = 2;
}
process.exitCode = code;
