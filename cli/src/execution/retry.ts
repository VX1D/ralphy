import { logDebug, logError, logWarn } from "../ui/logger.ts";
import {
	isRetryableError as isRetryableErrorFromUtils,
	standardizeError,
} from "../utils/errors.ts";

interface RetryOptions {
	maxRetries: number;
	retryDelay: number; // in seconds
	onRetry?: (attempt: number, error: string, delayMs: number) => void;
	/** Enable exponential backoff for connection errors */
	exponentialBackoff?: boolean;
	/** Maximum delay in seconds (default: 60) */
	maxDelay?: number;
	/** Add random jitter to delay (default: true) */
	jitter?: boolean;
}

/**
 * Circuit breaker states
 */
type CircuitState = "CLOSED" | "OPEN" | "HALF_OPEN";

interface CircuitBreakerConfig {
	failureThreshold: number;
	resetTimeoutMs: number;
	halfOpenMaxAttempts: number;
}

/**
 * Connection state manager using circuit breaker pattern.
 * Prevents infinite retries when connection is consistently failing.
 */
class ConnectionStateManager {
	private static instance: ConnectionStateManager;
	private circuitState: CircuitState = "CLOSED";
	private consecutiveFailures = 0;
	private lastFailureTime: number | null = null;
	private halfOpenAttempts = 0;

	private readonly config: CircuitBreakerConfig = {
		failureThreshold: 3,
		resetTimeoutMs: 30000,
		halfOpenMaxAttempts: 2,
	};

	static getInstance(): ConnectionStateManager {
		if (!ConnectionStateManager.instance) {
			ConnectionStateManager.instance = new ConnectionStateManager();
		}
		return ConnectionStateManager.instance;
	}

	canAttempt(): { allowed: boolean; reason?: string } {
		const now = Date.now();

		switch (this.circuitState) {
			case "CLOSED":
				return { allowed: true };

			case "OPEN": {
				if (this.lastFailureTime && now - this.lastFailureTime > this.config.resetTimeoutMs) {
					this.circuitState = "HALF_OPEN";
					this.halfOpenAttempts = 0;
					logWarn("Circuit breaker entering HALF_OPEN state - testing connection...");
					return { allowed: true };
				}
				const remainingMs = this.config.resetTimeoutMs - (now - (this.lastFailureTime || 0));
				return {
					allowed: false,
					reason: `Connection circuit OPEN - too many failures. Waiting ${Math.ceil(remainingMs / 1000)}s before retry...`,
				};
			}

			case "HALF_OPEN":
				if (this.halfOpenAttempts >= this.config.halfOpenMaxAttempts) {
					this.circuitState = "OPEN";
					this.lastFailureTime = now;
					return {
						allowed: false,
						reason: `Connection circuit OPEN - service still unavailable after ${this.config.halfOpenMaxAttempts} test attempts`,
					};
				}
				this.halfOpenAttempts++;
				return { allowed: true };
		}
	}

	recordSuccess(): void {
		if (this.circuitState === "HALF_OPEN") {
			this.circuitState = "CLOSED";
			this.consecutiveFailures = 0;
			this.halfOpenAttempts = 0;
			logWarn("Circuit breaker CLOSED - connection restored");
		} else {
			this.consecutiveFailures = 0;
		}
	}

	recordFailure(error: Error): void {
		const isConnectionError =
			isRetryableErrorFromUtils(error) &&
			/connection|network|timeout|unable to connect|internet connection|econnrefused|econnreset|socket hang up|dns|ENOTFOUND/i.test(
				error.message,
			);

		if (!isConnectionError) return;

		this.consecutiveFailures++;
		this.lastFailureTime = Date.now();

		if (this.circuitState === "HALF_OPEN") {
			this.circuitState = "OPEN";
			logWarn(`Circuit breaker OPEN - connection failed in half-open state`);
		} else if (this.consecutiveFailures >= this.config.failureThreshold) {
			this.circuitState = "OPEN";
			logError(
				`Circuit breaker OPEN - ${this.consecutiveFailures} consecutive connection failures. Stopping retries for ${this.config.resetTimeoutMs / 1000}s`,
			);
		}
	}

	getState(): { state: CircuitState; consecutiveFailures: number; lastFailureTime: number | null } {
		return {
			state: this.circuitState,
			consecutiveFailures: this.consecutiveFailures,
			lastFailureTime: this.lastFailureTime,
		};
	}

	reset(): void {
		this.circuitState = "CLOSED";
		this.consecutiveFailures = 0;
		this.halfOpenAttempts = 0;
		this.lastFailureTime = null;
		logWarn("Circuit breaker manually reset to CLOSED");
	}
}

/**
 * Sleep for a given number of milliseconds
 */
export function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Global circuit breaker instance
 */
export const circuitBreaker = ConnectionStateManager.getInstance();

/**
 * Check if connection is healthy enough to attempt requests
 */
export function canMakeConnectionAttempt(): { allowed: boolean; reason?: string } {
	return circuitBreaker.canAttempt();
}

/**
 * Reset connection circuit breaker
 */
export function resetConnectionCircuit(): void {
	circuitBreaker.reset();
}

/**
 * Get current connection health status
 */
export function getConnectionHealth(): {
	state: CircuitState;
	consecutiveFailures: number;
	lastFailureTime: number | null;
} {
	return circuitBreaker.getState();
}

/**
 * Calculate delay with exponential backoff and optional jitter
 */
export function calculateBackoffDelay(
	attempt: number,
	baseDelayMs: number,
	maxDelayMs: number,
	useJitter: boolean,
): number {
	let delay = baseDelayMs * 2 ** (attempt - 1);
	delay = Math.min(delay, maxDelayMs);

	if (useJitter) {
		const jitter = delay * 0.25 * Math.random();
		delay += jitter;
	}

	return Math.floor(delay);
}

/**
 * Execute a function with retry logic, exponential backoff, and circuit breaker.
 */
export async function withRetry<T>(fn: () => Promise<T>, options: RetryOptions): Promise<T> {
	const {
		maxRetries,
		retryDelay,
		onRetry,
		exponentialBackoff = true,
		maxDelay = 60,
		jitter = true,
	} = options;

	const baseDelayMs = retryDelay * 1000;
	const maxDelayMs = maxDelay * 1000;
	let lastError: Error | null = null;

	// Check circuit breaker before attempting
	const circuitCheck = circuitBreaker.canAttempt();
	if (!circuitCheck.allowed) {
		logError(`Circuit breaker preventing retry: ${circuitCheck.reason}`);
		throw new Error(circuitCheck.reason || "Connection circuit open - too many failures");
	}

	for (let attempt = 1; attempt <= maxRetries; attempt++) {
		try {
			const result = await fn();
			circuitBreaker.recordSuccess();
			return result;
		} catch (error) {
			lastError = standardizeError(error);

			// Record failure for circuit breaker tracking
			circuitBreaker.recordFailure(lastError);

			if (attempt < maxRetries) {
				const errorMsg = lastError.message;

				// Check if circuit is now open
				const currentState = circuitBreaker.canAttempt();
				if (!currentState.allowed) {
					logError(`Connection circuit opened after ${attempt} attempts: ${currentState.reason}`);
				}

				const delayMs = exponentialBackoff
					? calculateBackoffDelay(attempt, baseDelayMs, maxDelayMs, jitter)
					: baseDelayMs;

				logWarn(
					`Attempt ${attempt}/${maxRetries} failed: ${errorMsg}. Retrying in ${delayMs}ms...`,
				);
				onRetry?.(attempt, errorMsg, delayMs);

				logDebug(`Waiting ${(delayMs / 1000).toFixed(1)}s before retry (exponential backoff)...`);
				await sleep(delayMs);

				// Re-check circuit state before next attempt
				const recheck = circuitBreaker.canAttempt();
				if (!recheck.allowed) {
					throw new Error(recheck.reason || "Connection circuit open - stopping retries");
				}
			}
		}
	}

	throw lastError || new Error("All retry attempts failed");
}

/**
 * Check if an error is retryable (e.g., rate limit, network error).
 * Accepts both string (legacy) and Error/unknown for backward compatibility.
 */
export function isRetryableError(error: string | unknown): boolean {
	if (typeof error === "string") {
		const retryablePatterns = [
			/rate limit/i,
			/rate_limit/i,
			/hit your limit/i,
			/quota/i,
			/too many requests/i,
			/429/,
			/timeout/i,
			/network/i,
			/connection/i,
			/ECONNRESET/,
			/ETIMEDOUT/,
			/ENOTFOUND/,
			/overloaded/i,
		];
		return retryablePatterns.some((pattern) => pattern.test(error));
	}

	return isRetryableErrorFromUtils(error);
}

/**
 * Check if an error is fatal and should abort all remaining tasks.
 */
export function isFatalError(error: string): boolean {
	const fatalPatterns = [
		/not authenticated/i,
		/no authentication/i,
		/authentication failed/i,
		/invalid.*token/i,
		/invalid.*api.?key/i,
		/unauthorized/i,
		/\b401\b/i,
		/\b403\b/i,
		/command not found/i,
		/not installed/i,
		/is not recognized/i,
	];

	return fatalPatterns.some((pattern) => pattern.test(error));
}

/**
 * Wait for connection to be restored with timeout
 */
export async function waitForConnectionRestore(timeoutMs = 300000): Promise<boolean> {
	const checkInterval = 5000;
	const startTime = Date.now();

	logWarn("Waiting for connection to be restored...");

	while (Date.now() - startTime < timeoutMs) {
		const state = circuitBreaker.canAttempt();

		if (state.allowed) {
			logWarn("Connection restored - resuming execution");
			return true;
		}

		const elapsed = Math.floor((Date.now() - startTime) / 1000);
		const remaining = Math.floor((timeoutMs - (Date.now() - startTime)) / 1000);
		logWarn(
			`Still waiting for connection... (${elapsed}s elapsed, ${remaining}s timeout remaining)`,
		);

		await sleep(checkInterval);
	}

	logError("Connection restore timeout reached");
	return false;
}
