// Structured logging: one JSON object per line on stdout.
//
// Why JSON rather than prose? Logs are read by machines first. Cloud Logging
// can filter on fields ("every login_denied in the last week") instead of
// grepping sentences. JSON.stringify also escapes newlines, so a hostile
// file name or email can't forge a fake log line ("log injection").
//
// The container's stdout is picked up on the VM and shipped to Cloud Logging
// (see `google-logging-enabled` in infra/vm.tf).

type Severity = "INFO" | "WARNING" | "ERROR";

function write(severity: Severity, event: string, fields: Record<string, unknown>) {
  // `severity`, `message` and `time` are field names Cloud Logging recognises.
  const line = JSON.stringify({
    severity,
    time: new Date().toISOString(),
    message: event,
    event,
    ...fields,
  });
  // Errors to stderr, the rest to stdout — both are collected.
  if (severity === "ERROR") console.error(line);
  else console.log(line);
}

/**
 * Audit trail: WHO did WHAT. Every call names an `event` from a small fixed
 * vocabulary so they can be queried reliably:
 *   login_allowed | login_denied | login_failed | logout
 *   dir_list | file_view | access_denied
 */
export function audit(event: string, fields: Record<string, unknown> = {}) {
  // Denials are worth noticing; everything else is routine.
  const severity: Severity = event.endsWith("_denied") ? "WARNING" : "INFO";
  write(severity, event, { audit: true, ...fields });
}

export function logError(event: string, err: unknown) {
  write("ERROR", event, {
    error: err instanceof Error ? err.message : String(err),
    stack: err instanceof Error ? err.stack : undefined,
  });
}
