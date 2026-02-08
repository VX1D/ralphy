/**
 * Standardized error handling utilities for consistent error types across the codebase
 */

export class RalphyError extends Error {
	public readonly code: string;
	public readonly context?: Record<string, unknown>;

	constructor(message: string, code = "RALPHY_ERROR", context?: Record<string, unknown>) {
		super(message);
		this.name = "RalphyError";
		this.code = code;
		this.context = context;

		// Maintains proper stack trace for where our error was thrown (only available on V8)
		if (Error.captureStackTrace) {
			Error.captureStackTrace(this, RalphyError);
		}
	}
}

export class ValidationError extends RalphyError {
	constructor(message: string, context?: Record<string, unknown>) {
		super(message, "VALIDATION_ERROR", context);
		this.name = "ValidationError";
	}
}

export class TimeoutError extends RalphyError {
	constructor(message: string, context?: Record<string, unknown>) {
		super(message, "TIMEOUT_ERROR", context);
		this.name = "TimeoutError";
	}
}

export class ProcessError extends RalphyError {
	constructor(message: string, context?: Record<string, unknown>) {
		super(message, "PROCESS_ERROR", context);
		this.name = "ProcessError";
	}
}

/**
 * Convert any error to a standardized format
 */
export function standardizeError(error: unknown): RalphyError {
	if (error instanceof RalphyError) {
		return error;
	}

	if (error instanceof Error) {
		return new RalphyError(error.message, "UNKNOWN_ERROR", {
			originalName: error.name,
			originalStack: error.stack,
		});
	}

	if (typeof error === "string") {
		return new RalphyError(error, "STRING_ERROR");
	}

	return new RalphyError(String(error), "UNKNOWN_ERROR", { originalType: typeof error });
}

/**
 * Check if an error is retryable based on error codes and message patterns
 */
export function isRetryableError(error: unknown): boolean {
	const standardized = standardizeError(error);

	const retryableCodes = ["TIMEOUT_ERROR", "PROCESS_ERROR", "NETWORK_ERROR", "RATE_LIMIT_ERROR"];

	const retryableMessages = [
		"timeout",
		"connection refused",
		"network",
		"rate limit",
		"too many requests",
		"temporary failure",
		"try again",
		"connection error",
		"unable to connect",
		"internet connection",
		"econnrefused",
		"econnreset",
		"socket hang up",
		"fetch failed",
	];

	const message = standardized.message.toLowerCase();

	if (retryableCodes.includes(standardized.code)) {
		return true;
	}

	return retryableMessages.some((pattern) => message.includes(pattern));
}
