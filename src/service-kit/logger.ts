// One JSON object per line on stdout (ADR 0111). Never pass secrets, tokens or personal data as fields.

export type LogLevel = "debug" | "info" | "warn" | "error";
export type LogFields = Record<string, unknown>;

export interface Logger {
  log(level: LogLevel, message: string, fields?: LogFields): void;
  info(message: string, fields?: LogFields): void;
  warn(message: string, fields?: LogFields): void;
  error(message: string, fields?: LogFields): void;
}

export function createLogger(
  service: string,
  write: (line: string) => void = (line) => process.stdout.write(`${line}\n`),
  now: () => Date = () => new Date(),
): Logger {
  const log = (level: LogLevel, message: string, fields: LogFields = {}): void => {
    // Fields come first so they can never overwrite the standard keys.
    write(
      JSON.stringify({ ...fields, time: now().toISOString(), level, service, message }),
    );
  };
  return {
    log,
    info: (message, fields) => log("info", message, fields),
    warn: (message, fields) => log("warn", message, fields),
    error: (message, fields) => log("error", message, fields),
  };
}
