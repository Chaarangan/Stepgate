# Stepgate

A portable, API-only format for an agent's procedure, and the MCP server that gates the connecting client's agent through it step by step.

## Language

**Stepfile**:
One YAML or JSON file declaring inputs, tools, credentials and an ordered list of steps. Names no model, provider or framework.
_Avoid_: runbook, agent file, bundle, workflow, playbook

**Step**:
One unit of a stepfile: instructions, the tools it may call, the output it must submit, and its gates.
_Avoid_: task, node, stage

**Gate**:
A mechanical check on a step's submitted output, or a person's approval of it, that decides whether the step passed. Never judged by a model.
_Avoid_: guardrail, validator, check, assertion

**Output**:
The JSON object a step submits, validated against the step's declared schema.
_Avoid_: artifact, result, file

**Tool**:
A remote API or MCP server a stepfile declares, together with the operations it exposes to steps.
_Avoid_: connector, integration, plugin

**Credential**:
A named requirement for a secret, declared by kind, scopes, hosts and description. The stepfile never holds or locates the value.
_Avoid_: secret, env var, key

**Stepgate**:
The MCP server that runs stepfiles: it offers each one as a tool, shows the client one step at a time, performs every tool call, evaluates gates and writes the ledger. Also its command, `stepgate`.
_Avoid_: runtime, SDK, engine, host

**Client**:
The MCP client that connects to Stepgate, starts runs, and does each step with its own model through Stepgate's tools.
_Avoid_: host, caller

**Draft**:
A stepfile passed to Stepgate as text to try, rather than loaded at start. Runs without credentials or settings.
_Avoid_: scratch file, prototype

**Preflight**:
Everything Stepgate checks before the first step: inputs, credentials, tool documents and exposed operations.
_Avoid_: setup, init

**Ledger**:
The hash-chained record of a run: steps, tool calls, gate verdicts and retries.
_Avoid_: log, transcript, trace
