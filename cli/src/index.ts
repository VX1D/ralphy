#!/usr/bin/env bun
import { parseArgs } from "./cli/args.ts";
import { addRule, showConfig } from "./cli/commands/config.ts";
import { runInit } from "./cli/commands/init.ts";
import { runLoop } from "./cli/commands/run.ts";
import { runTask } from "./cli/commands/task.ts";
import { flushAllProgressWrites } from "./config/writer.ts";
import { logError } from "./ui/logger.ts";
import { runCleanup, setupSignalHandlers } from "./utils/cleanup.ts";
import { standardizeError } from "./utils/errors.ts";

// Setup signal handlers for graceful cleanup of child processes
setupSignalHandlers();

// Catch unhandled rejections
process.on("unhandledRejection", (reason) => {
	logError(`Unhandled rejection: ${reason instanceof Error ? reason.message : String(reason)}`);
});

async function main(): Promise<void> {
	try {
		const {
			options,
			task,
			initMode,
			showConfig: showConfigMode,
			addRule: rule,
		} = parseArgs(process.argv);

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
		const standardized = standardizeError(error);
		logError(standardized.message);
		process.exitCode = 1;
	} finally {
		// Ensure all progress writes are flushed and cleanup runs before exit
		await flushAllProgressWrites();
		await runCleanup();
	}
}

main();
