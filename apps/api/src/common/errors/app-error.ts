export interface AppErrorOptions {
  /** HTTP status code to respond with. */
  status: number;
  /** Short, human-readable summary of the problem type. */
  title: string;
  /** Explanation specific to this occurrence. */
  detail?: string;
  /** URI reference identifying the problem type. Defaults to about:blank. */
  type?: string;
  cause?: unknown;
  /** Extra members added to the problem body (e.g. `errors[]` for validation failures). */
  extensions?: Record<string, unknown>;
}

/**
 * Base class for domain and application errors. Thrown errors of this type are
 * rendered by HttpExceptionFilter as RFC 7807 problem details.
 */
export class AppError extends Error {
  readonly status: number;
  readonly title: string;
  readonly type: string;
  readonly detail: string | undefined;
  readonly extensions: Record<string, unknown> | undefined;

  constructor(options: AppErrorOptions) {
    super(options.detail ?? options.title, { cause: options.cause });
    this.name = new.target.name;
    this.status = options.status;
    this.title = options.title;
    this.type = options.type ?? 'about:blank';
    this.detail = options.detail;
    this.extensions = options.extensions;
  }
}

export function isAppError(value: unknown): value is AppError {
  return value instanceof AppError;
}
