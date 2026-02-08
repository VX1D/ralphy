const isWindows = process.platform === "win32";

/**
 * Validate command name to prevent command injection.
 * Only allows alphanumeric characters, hyphens, underscores, and dots.
 * Also allows forward slashes for path-based commands (e.g., ./node_modules/.bin/cli)
 */
export function validateCommand(command: string): string | null {
	// Block shell metacharacters and dangerous patterns
	const dangerousPatterns = [
		/[;&|`$]/, // Shell metacharacters
		/\$\{/, // Variable expansion
		/\$\(/, // Command substitution
		/`/, // Backtick substitution
		/\|\|/, // OR operator
		/&&/, // AND operator
		/[<>]/, // Redirection
	];

	for (const pattern of dangerousPatterns) {
		if (pattern.test(command)) {
			return null;
		}
	}

	// Allow valid command characters
	const validCommandPattern = isWindows ? /^[a-zA-Z0-9._\-\\]+$/ : /^[a-zA-Z0-9._\-/]+$/;

	if (!validCommandPattern.test(command)) {
		return null;
	}

	return command;
}

/**
 * Validate command arguments to prevent injection.
 * Returns null if any argument contains dangerous patterns.
 */
export function validateArgs(args: string[]): string[] | null {
	const dangerousPatterns = [
		/[;&|`]/, // Shell metacharacters
		/\$\{/, // Variable expansion
		/\$\(/, // Command substitution
		/`/, // Backtick substitution
		/\|\|/, // OR operator
		/&&/, // AND operator
	];

	for (const arg of args) {
		for (const pattern of dangerousPatterns) {
			if (pattern.test(arg)) {
				return null;
			}
		}
	}

	return args;
}

/**
 * Validation result type
 */
export interface ValidationResult {
	valid: boolean;
	command?: string;
	args?: string[];
	error?: string;
}

/**
 * Validate both command and arguments in one call
 */
export function validateCommandAndArgs(command: string, args: string[]): ValidationResult {
	const validatedCommand = validateCommand(command);
	if (!validatedCommand) {
		return {
			valid: false,
			error: "Invalid command - potential command injection detected",
		};
	}

	const validatedArgs = validateArgs(args);
	if (!validatedArgs) {
		return {
			valid: false,
			error: "Invalid arguments - potential command injection detected",
		};
	}

	return {
		valid: true,
		command: validatedCommand,
		args: validatedArgs,
	};
}
