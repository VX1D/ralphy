import type { z } from "zod";
import { ErrorSchema, parseJsonLine, StepFinishSchema } from "../utils/json-validation.ts";
import type { AIResult } from "./types.ts";

/**
 * Parsed result with token counts
 */
export interface ParsedResult {
	response: string;
	inputTokens: number;
	outputTokens: number;
}

/**
 * Token counts
 */
export interface TokenCounts {
	input: number;
	output: number;
}

/**
 * Check for errors in stream-json output or general CLI output.
 * Uses Zod schema validation for structured JSON and pattern matching for plain text.
 */
export function checkForErrors(output: string): string | null {
	const lines = output.split("\n").filter(Boolean);

	for (const line of lines) {
		const trimmed = line.trim();
		// Try JSON parsing with schema validation
		if (trimmed.startsWith("{")) {
			const parsed = parseJsonLine(line);
			if (parsed && ErrorSchema.safeParse(parsed.event).success) {
				const errorData = parsed.event as z.infer<typeof ErrorSchema>;
				return errorData.error?.message || errorData.message || "Unknown error";
			}
		}

		// Look for common error patterns in plain text
		const lowerTrimmed = trimmed.toLowerCase();

		if (lowerTrimmed.includes("rate limit")) {
			return "Rate Limit: Too many requests. Wait 30-60s before retrying";
		}
		if (lowerTrimmed.includes("quota")) {
			return "Quota Exceeded: You've reached your usage limit";
		}
		if (lowerTrimmed.includes("connection") || lowerTrimmed.includes("timeout")) {
			return "Connection Error: Unable to connect to the service. Check internet connection";
		}

		if (
			lowerTrimmed.startsWith("fatal:") ||
			lowerTrimmed.startsWith("error:") ||
			lowerTrimmed.includes("providermodelnotfounderror") ||
			lowerTrimmed.includes("modelnotfounderror") ||
			lowerTrimmed.includes("model not found") ||
			lowerTrimmed.includes("invalid model") ||
			lowerTrimmed.includes("not available")
		) {
			return trimmed;
		}
	}

	// Secondary check for common fatal strings
	if (
		output.includes("Permission denied") ||
		output.includes("command not found") ||
		output.toLowerCase().includes("providermodelnotfounderror")
	) {
		return output.trim().split("\n").pop() || "Access or command error";
	}

	return null;
}

/**
 * Format a command failure with useful output context.
 */
export function formatCommandError(exitCode: number, output: string): string {
	const trimmed = output.trim();
	if (!trimmed) {
		return `Command failed with code ${exitCode} (no output)`;
	}

	const extractedError = checkForErrors(output);
	if (extractedError) {
		return `Error (${exitCode}): ${extractedError}`;
	}

	const lines = trimmed.split("\n").filter(Boolean);
	const snippet = lines.slice(-5).join("\n");
	return `exit code ${exitCode}. Last output:\n${snippet}`;
}

/**
 * Parse JSON result from AI output (Claude/Qwen stream-json format)
 */
export function parseStreamJsonResult(output: string): ParsedResult {
	const lines = output.split("\n").filter(Boolean);
	let response = "";
	let inputTokens = 0;
	let outputTokens = 0;

	for (const line of lines) {
		try {
			const parsed = JSON.parse(line);
			if (parsed.type === "result") {
				response = parsed.result || "Task completed";
				inputTokens = parsed.usage?.input_tokens || 0;
				outputTokens = parsed.usage?.output_tokens || 0;
			}
		} catch {
			// Ignore non-JSON lines
		}
	}

	return { response: response || "Task completed", inputTokens, outputTokens };
}

/**
 * Extract token counts from JSON response using schema validation
 */
export function extractTokenCounts(output: string): TokenCounts | null {
	const lines = output.split("\n").filter(Boolean);
	for (const line of lines) {
		if (line.trim().startsWith("{")) {
			const parsed = parseJsonLine(line);
			if (!parsed) continue;

			const stepFinishResult = StepFinishSchema.safeParse(parsed.event);
			if (stepFinishResult.success) {
				const stepFinish = stepFinishResult.data;
				const tokens = stepFinish.part?.tokens || stepFinish.tokens;
				if (tokens) {
					return {
						input: tokens.input || 0,
						output: tokens.output || 0,
					};
				}
			}
		}
	}
	return null;
}

/**
 * Detect the current step from a JSON output line.
 * Returns step name like "Reading code", "Implementing", etc.
 */
export function detectStepFromOutput(line: string): string | null {
	const trimmed = line.trim();
	if (!trimmed.startsWith("{")) {
		return null;
	}

	try {
		const parsed = JSON.parse(trimmed);

		const toolName =
			parsed.tool?.toLowerCase() ||
			parsed.name?.toLowerCase() ||
			parsed.tool_name?.toLowerCase() ||
			"";
		const command = parsed.command?.toLowerCase() || "";
		const filePath = (parsed.file_path || parsed.filePath || parsed.path || "").toLowerCase();

		const isReadOperation = toolName === "read" || toolName === "glob" || toolName === "grep";
		const isWriteOperation = toolName === "write" || toolName === "edit";

		if (isReadOperation) {
			return "Reading code";
		}

		if (command.includes("git commit")) {
			return "Committing";
		}

		if (command.includes("git add")) {
			return "Staging";
		}

		if (
			command.includes("lint") ||
			command.includes("eslint") ||
			command.includes("biome") ||
			command.includes("prettier")
		) {
			return "Linting";
		}

		if (
			command.includes("vitest") ||
			command.includes("jest") ||
			command.includes("bun test") ||
			command.includes("npm test") ||
			command.includes("pytest") ||
			command.includes("go test")
		) {
			return "Testing";
		}

		if (isWriteOperation && isTestFile(filePath)) {
			return "Writing tests";
		}

		if (isWriteOperation) {
			return "Implementing";
		}

		return null;
	} catch {
		return null;
	}
}

/**
 * Check if a file path looks like a test file
 */
function isTestFile(filePath: string): boolean {
	const lower = filePath.toLowerCase();
	return (
		lower.includes(".test.") ||
		lower.includes(".spec.") ||
		lower.includes("__tests__") ||
		lower.includes("_test.go")
	);
}

/**
 * Create error result from exit code and output
 */
export function createErrorResult(
	exitCode: number,
	output: string,
	response = "",
	inputTokens = 0,
	outputTokens = 0,
): AIResult {
	return {
		success: false,
		response,
		inputTokens,
		outputTokens,
		error: formatCommandError(exitCode, output),
	};
}

/**
 * Create success result with response and token counts
 */
export function createSuccessResult(
	response: string,
	inputTokens: number,
	outputTokens: number,
	extra?: Record<string, unknown>,
): AIResult {
	return {
		success: true,
		response,
		inputTokens,
		outputTokens,
		...extra,
	};
}

/**
 * Extract authentication error message from stream-json output.
 */
export function extractAuthenticationError(output: string): string | null {
	const lines = output.split("\n").filter(Boolean);

	for (const line of lines) {
		try {
			const parsed = JSON.parse(line);

			if (
				parsed.type === "error" ||
				parsed.is_error === true ||
				parsed.error === "authentication_failed"
			) {
				let message = "";
				const content = parsed.message?.content;
				if (Array.isArray(content)) {
					const textItem = content.find(
						(item: { type?: string; text?: string }) => item.type === "text" && item.text,
					);
					if (textItem) message = textItem.text;
				}
				if (!message) {
					message = parsed.result || parsed.error?.message || parsed.message || "";
				}

				if (message && isAuthenticationMessage(message.toLowerCase())) {
					return message;
				}
			}
		} catch {
			// Ignore non-JSON lines
		}
	}

	return null;
}

function isAuthenticationMessage(messageLower: string): boolean {
	return (
		messageLower.includes("invalid api key") ||
		messageLower.includes("authentication") ||
		messageLower.includes("not authenticated") ||
		messageLower.includes("unauthorized") ||
		messageLower.includes("/login")
	);
}
