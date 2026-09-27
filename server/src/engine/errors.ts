/** Base class for every error the engine raises. */
export class StepgateError extends Error {
  override name = "StepgateError";
}

export type ValidationIssue = { path: string; message: string };

/** The stepfile text failed parsing, the schema, or a cross-field rule. */
export class StepfileInvalid extends StepgateError {
  override name = "StepfileInvalid";
  readonly issues: ValidationIssue[];
  constructor(issues: ValidationIssue[]) {
    super(`stepfile invalid: ${issues.map((issue) => `${issue.path || "/"} ${issue.message}`).join("; ")}`);
    this.issues = issues;
  }
}

/** A precondition checked before step 1 did not hold, so no step ran. */
export class PreflightFailed extends StepgateError {
  override name = "PreflightFailed";
  readonly item: string;
  constructor(item: string, reason: string, options?: ErrorOptions) {
    super(`preflight failed for ${item}: ${reason}`, options);
    this.item = item;
  }
}

/** Raised when a credential cannot be supplied from Stepgate's environment. */
export class CredentialUnavailable extends StepgateError {
  override name = "CredentialUnavailable";
  readonly credential: string;
  constructor(credential: string, reason: string) {
    super(`credential ${credential} unavailable: ${reason}`);
    this.credential = credential;
  }
}

/** Raised when a setting the stepfile declares has no value in Stepgate's environment. */
export class SettingUnavailable extends StepgateError {
  override name = "SettingUnavailable";
  readonly setting: string;
  constructor(setting: string, reason: string) {
    super(`setting ${setting} unavailable: ${reason}`);
    this.setting = setting;
  }
}

/** An OAuth grant was revoked. Never retried. */
export class InvalidGrant extends StepgateError {
  override name = "InvalidGrant";
  readonly credential: string;
  constructor(credential: string, detail: string) {
    super(`credential ${credential} has an invalid grant: ${detail}`);
    this.credential = credential;
  }
}

/** A request targeted a host no tool in the stepfile declares. */
export class EgressDenied extends StepgateError {
  override name = "EgressDenied";
  readonly host: string;
  constructor(host: string, operation: string) {
    super(`egress denied: ${operation} targeted undeclared host ${host}`);
    this.host = host;
  }
}

/** An external call failed in a way retrying did not fix. */
export class ToolCallFailed extends StepgateError {
  override name = "ToolCallFailed";
  readonly operation: string;
  readonly status: number | null;
  readonly body: string;
  constructor(operation: string, status: number | null, body: string, options?: ErrorOptions) {
    super(`${operation} failed with status ${status ?? "none"}: ${body.slice(0, 500)}`, options);
    this.operation = operation;
    this.status = status;
    this.body = body;
  }
}

/** A response was larger than the operator lets Stepgate read. */
export class ResponseTooLarge extends StepgateError {
  override name = "ResponseTooLarge";
  readonly operation: string;
  readonly limit: number;
  constructor(operation: string, limit: number) {
    super(`${operation} returned more than the ${limit} bytes Stepgate reads (--response-bytes)`);
    this.operation = operation;
    this.limit = limit;
  }
}

export class PlaceholderUnresolved extends StepgateError {
  override name = "PlaceholderUnresolved";
  readonly placeholder: string;
  constructor(stepId: string, placeholder: string) {
    super(`step ${stepId}: placeholder {{${placeholder}}} did not resolve`);
    this.placeholder = placeholder;
  }
}

export type GateDiagnosis = { gate: string; diagnosis: string };

/** A step used up its retries without every gate passing. */
export class GateFailed extends StepgateError {
  override name = "GateFailed";
  readonly step: string;
  readonly failures: GateDiagnosis[];
  constructor(step: string, failures: GateDiagnosis[]) {
    super(`step ${step} failed gates: ${failures.map((failure) => `${failure.gate}: ${failure.diagnosis}`).join("; ")}`);
    this.step = step;
    this.failures = failures;
  }
}

/** A mechanical step computed arguments its operation's schema refuses, which no model is there to correct. */
export class CallArgumentsInvalid extends StepgateError {
  override name = "CallArgumentsInvalid";
  readonly step: string;
  readonly call: string;
  constructor(step: string, call: string, operation: string, problems: string) {
    super(`step ${step} computed arguments for call ${call} (${operation}) that its schema refuses: ${problems}`);
    this.step = step;
    this.call = call;
  }
}

/** A step made more tool calls than Stepgate allows, which usually means the client is looping. */
export class CallLimitReached extends StepgateError {
  override name = "CallLimitReached";
  readonly step: string;
  constructor(step: string, limit: number) {
    super(`step ${step} reached the limit of ${limit} tool calls`);
    this.step = step;
  }
}

/** No run with this id is in progress: it finished, failed, expired, or was never started. */
export class RunNotActive extends StepgateError {
  override name = "RunNotActive";
  readonly run: string;
  constructor(run: string) {
    super(`run ${run} is not active; it finished, failed or expired, so call the stepfile's tool again to start a new run`);
    this.run = run;
  }
}

/** A draft passed to stepgate_try breaks a rule drafts must follow, such as declaring a credential. */
export class DraftRefused extends StepgateError {
  override name = "DraftRefused";
  readonly problems: string[];
  constructor(problems: string[]) {
    super(`draft refused: ${problems.join("; ")}`);
    this.problems = problems;
  }
}

/** An authoring tool was asked to contact a URL that is not public https. */
export class UrlNotPublic extends StepgateError {
  override name = "UrlNotPublic";
  readonly url: string;
  constructor(url: string) {
    super(`${url} is not a public https URL`);
    this.url = url;
  }
}

/** A fetched API description is not a JSON or YAML object. */
export class ApiDocumentInvalid extends StepgateError {
  override name = "ApiDocumentInvalid";
  readonly url: string;
  constructor(url: string, reason: string) {
    super(`API document ${url} is invalid: ${reason}`);
    this.url = url;
  }
}

/** A gate test cases file failed its schema, or names a step or gate the stepfile does not have. */
export class CasesInvalid extends StepgateError {
  override name = "CasesInvalid";
  readonly problems: string[];
  constructor(problems: string[]) {
    super(`cases invalid: ${problems.join("; ")}`);
    this.problems = problems;
  }
}

/** No catalog entry has this name. */
export class UnknownStepfile extends StepgateError {
  override name = "UnknownStepfile";
  readonly stepfile: string;
  constructor(stepfile: string, available: string[]) {
    super(`no catalog stepfile named ${stepfile}; available: ${available.join(", ") || "none"}`);
    this.stepfile = stepfile;
  }
}

/** A catalog folder breaks the catalog's rules. */
export class CatalogEntryInvalid extends StepgateError {
  override name = "CatalogEntryInvalid";
  readonly entry: string;
  readonly problems: string[];
  constructor(entry: string, problems: string[]) {
    super(`catalog entry ${entry} is invalid: ${problems.join("; ")}`);
    this.entry = entry;
    this.problems = problems;
  }
}
