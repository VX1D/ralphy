#!/usr/bin/env bun
import { parseArgs } from "./cli/args.ts";
import { addRule, showConfig } from "./cli/commands/config.ts";
import { runConvert } from "./cli/commands/convert.ts";
import { runInit } from "./cli/commands/init.ts";
import { runLoop } from "./cli/commands/run.ts";
import { runTask } from "./cli/commands/task.ts";
import { logError } from "./ui/logger.ts";
import { runCleanup, setupSignalHandlers } from "./utils/cleanup.ts";
import { standardizeError } from "./utils/errors.ts";

// Setup global cleanup and signal handlers
setupSignalHandlers();

// Handle unhandled promise rejections globally
process.on("unhandledRejection", (reason, promise) => {
	// BUG FIX: Preserve error stack traces for better debugging
	const errorMessage =
		reason instanceof Error ? `${reason.message}\n${reason.stack}` : String(reason);
	logError(`Unhandled Promise Rejection: ${errorMessage}`);
	logError(`Promise: ${promise}`);
	// Don't crash, but log and continue - prevent uncaught exception
});

	// Handle uncaught exceptions globally
process.on("uncaughtException", (error) => {
	logError(`Uncaught Exception: ${error.message}`);
	logError(`Stack: ${error.stack}`);
	runCleanup()
		.catch((cleanupError: unknown) => {
			logError(
				`Cleanup failed during uncaught exception: ${cleanupError instanceof Error ? cleanupError.message : cleanupError}`,
			);
		})
		.finally(() => {
			// Set exit code instead of calling exit immediately
			// This allows the cleanup promise to resolve before Node.js exits
			process.exitCode = 1;
		});
});

async function main(): Promise<void> {
	try {
		const {
			options,
			task,
			initMode,
			showConfig: showConfigMode,
			addRule: rule,
			convertFrom,
			convertTo,
		} = parseArgs(process.argv);

		// Handle --convert-from
		if (convertFrom) {
			const outputFile = convertTo || `${convertFrom.replace(/\.[^.]+$/, "")}.csv`;
			await runConvert({ from: convertFrom, to: outputFile, verbose: options.verbose });
			return;
		}

		// Handle --init
		if (initMode) {
			await runInit();
			return;
		}

		// Handle --config
		if (showConfigMode) {
			await showConfig();
			return;
		}

		// Handle --add-rule
		if (rule) {
			await addRule(rule);
			return;
		}

		// Single task mode (brownfield)
		if (task) {
			await runTask(task, options);
			return;
		}

		// PRD loop mode
		await runLoop(options);
	} catch (error) {
		logError(standardizeError(error).message);
		await runCleanup();
		process.exit(1);
	}
}

// BUG FIX: Await main() to prevent floating promise and ensure proper error handling
await main();
