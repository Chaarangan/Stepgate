# Security policy

## Reporting a vulnerability

Please report vulnerabilities privately through GitHub: open the repository's **Security** tab and choose **Report a vulnerability**. Do not open a public issue.

Include the stepfile (or a minimal one) that shows the problem, what you expected, what happened, and the `stepgate` version. A report is acknowledged and then fixed or answered with a decision; Stepgate is maintained by one person, so timing depends on severity.

## Supported versions

Only the latest release receives fixes while the project is below 1.0.

## What counts as a vulnerability

`stepgate` runs stepfiles, which it treats as untrusted, on a client's model. These are the guarantees a report would break:

- **Credentials stay out of the model's context.** A credential value must never appear in a sampling request, a tool result shown to the model, the ledger, or an error message.
- **Requests go only to declared hosts.** No argument, placeholder or tool result may send a request to a host the stepfile does not declare.
- **Steps run in order, in isolation.** The model must not see a later step's instructions, another step's conversation, or the stepfile itself.
- **Gates decide.** A step must not pass unless every gate passes over the output the model submitted.
- **The ledger is tamper-evident.** Editing a record must break the hash chain.

Prompt injection that stays inside these guarantees, such as a tool result persuading the model to submit poor output that still passes weak gates, is a limit of the stepfile's gates rather than a vulnerability. Reports that improve what gates can express are still welcome as issues.
