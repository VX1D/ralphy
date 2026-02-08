import type { ChildProcess } from "node:child_process";
import { spawnSync } from "node:child_process";

type CleanupFn = () => Promise<void> | void;

const cleanupRegistry: Set<CleanupFn> = new Set();
const trackedProcesses: Set<ChildProcess> = new Set();
let isCleaningUp = false;

/**
 * Register a function to be called on process exit or manual cleanup
 */
export function registerCleanup(fn: CleanupFn): () => void {
	cleanupRegistry.add(fn);
	return () => cleanupRegistry.delete(fn);
}

/**
 * Register a child process to be tracked and killed on exit
 */
export function registerProcess(proc: ChildProcess): () => void {
	trackedProcesses.add(proc);

	const remove = () => trackedProcesses.delete(proc);

	proc.on("exit", remove);
	proc.on("error", remove);

	return remove;
}

/**
 * Run all registered cleanup functions and kill tracked processes
 */
export async function runCleanup(): Promise<void> {
	if (isCleaningUp) return;
	isCleaningUp = true;

	// 1. Kill all tracked child processes with verification
	for (const proc of trackedProcesses) {
		try {
			if (proc.connected || proc.pid) {
				const pid = proc.pid;

				if (process.platform === "win32") {
					// Windows needs taskkill for robust child tree termination
					spawnSync("taskkill", ["/pid", String(pid), "/f", "/t"], {
						stdio: "pipe",
					});
				} else {
					// Try graceful termination first
					proc.kill("SIGTERM");

					// Wait a bit and verify it's dead
					await new Promise((resolve) => setTimeout(resolve, 1000));

					// Check if process is still running
					if (proc.connected || proc.pid) {
						proc.kill("SIGKILL");
					}
				}
			}
		} catch {
			// Ignore cleanup errors
		}
	}
	trackedProcesses.clear();

	// 2. Run registered cleanup functions
	const promises: Promise<void>[] = [];
	for (const fn of cleanupRegistry) {
		try {
			const result = fn();
			if (result instanceof Promise) {
				promises.push(result);
			}
		} catch {
			// Ignore cleanup errors
		}
	}

	await Promise.allSettled(promises);
	cleanupRegistry.clear();
	isCleaningUp = false;
}

/**
 * Setup process signal handlers for cleanup
 */
export function setupSignalHandlers(): void {
	const signals: NodeJS.Signals[] = ["SIGINT", "SIGTERM"];

	for (const signal of signals) {
		process.on(signal, async () => {
			process.stdout.write(`\nReceived ${signal}, cleaning up processes and files...\n`);
			await runCleanup();
			process.exit(0);
		});
	}
}
