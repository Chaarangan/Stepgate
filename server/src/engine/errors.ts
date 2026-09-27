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

export class TurnLimitReached extends StepgateError {
  override name = "TurnLimitReached";
  readonly step: string;
  constructor(step: string, limit: number) {
    super(`step ${step} reached the limit of ${limit} model turns`);
    this.step = step;
  }
}

/** A model turn failed, for example a rejected sampling request. The original error is the cause. */
export class ModelTurnFailed extends StepgateError {
  override name = "ModelTurnFailed";
  readonly step: string;
  constructor(step: string, cause: unknown) {
    super(`model turn failed in step ${step}: ${cause instanceof Error ? cause.message : String(cause)}`, { cause });
    this.step = step;
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
