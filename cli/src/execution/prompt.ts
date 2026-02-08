import { existsSync } from "node:fs";
import { join } from "node:path";
import { loadBoundaries, loadProjectContext, loadRules } from "../config/loader.ts";
import type { Task } from "../tasks/types.ts";
import { getBrowserInstructions, isBrowserAvailable } from "./browser.ts";

interface PromptOptions {
	task: string;
	autoCommit?: boolean;
	workDir?: string;
	browserEnabled?: "auto" | "true" | "false";
	skipTests?: boolean;
	skipLint?: boolean;
	prdFile?: string;
}

/**
 * Detect skill/playbook directories that can guide the agent.
 * We keep this engine-agnostic: OpenCode can load skills via `skill` tool,
 * other engines can still read these docs as repo guidance.
 */
function detectAgentSkills(workDir: string): string[] {
	const candidates = [
		join(workDir, ".opencode", "skills"),
		join(workDir, ".claude", "skills"),
		join(workDir, ".github", "skills"),
		join(workDir, ".skills"),
	];

	return candidates.filter((p) => existsSync(p));
}

/**
 * Build the full prompt with project context, rules, boundaries, and task
 */
export function buildPrompt(options: PromptOptions): string {
	const {
		task,
		autoCommit = true,
		workDir = process.cwd(),
		browserEnabled = "auto",
		skipTests = false,
		skipLint = false,
		prdFile,
	} = options;

	const parts: string[] = [];

	// Add project context if available
	const context = loadProjectContext(workDir);
	if (context) {
		parts.push(`## Project Context\n${context}`);
	}

	// Add rules if available
	const rules = loadRules(workDir);
	const codeChangeRules = [
		"Keep changes focused and minimal. Do not refactor unrelated code.",
		"One logical change per commit. If a task is too large, break it into subtasks.",
		"Write concise code. Avoid over-engineering.",
		"Don't leave dead code. Delete unused code completely.",
		"Quality over speed. Small steps compound into big progress.",
		...rules,
	];
	if (codeChangeRules.length > 0) {
		parts.push(
			`## Rules (you MUST follow these)\n${codeChangeRules.map((r) => `- ${r}`).join("\n")}`,
		);
	}

	// Add boundaries - combine system boundaries with user-defined boundaries
	// System boundaries come first to ensure they are prominently visible
	const userBoundaries = loadBoundaries(workDir);
	const systemBoundaries = [
		prdFile || "the PRD file",
		".ralphy/progress.txt",
		".ralphy-worktrees",
		".ralphy-sandboxes",
	];
	const allBoundaries = [...systemBoundaries, ...userBoundaries];
	parts.push(
		`## Boundaries\nDo NOT modify these files/directories:\n${allBoundaries.map((b) => `- ${b}`).join("\n")}`,
	);

	// Agent skills/playbooks (optional)
	const skillRoots = detectAgentSkills(workDir);
	if (skillRoots.length > 0) {
		parts.push(
			[
				"## Agent Skills",
				"This repo includes skill/playbook docs that describe preferred patterns, workflows, or tooling:",
				...skillRoots.map((p) => `- ${p}`),
				"",
				"Before you start coding:",
				"- Read and follow any relevant skill docs from the paths above.",
				"- If your engine supports a `skill` tool (e.g. OpenCode), use it to load the relevant skills before implementing.",
				"- If none apply, continue normally.",
			].join("\n"),
		);
	}

	// Add browser instructions if available
	if (isBrowserAvailable(browserEnabled)) {
		parts.push(getBrowserInstructions());
	}

	// Add the task
	parts.push(`## Task\n${task}`);

	// Add instructions
	const instructions = ["1. Implement the task described above"];

	let step = 2;
	if (!skipTests) {
		instructions.push(`${step}. Write tests for the feature`);
		step++;
		instructions.push(`${step}. Run tests and ensure they pass before proceeding`);
		step++;
	}

	if (!skipLint) {
		instructions.push(`${step}. Run linting and ensure it passes`);
		step++;
	}

	instructions.push(`${step}. Ensure the code works correctly`);
	step++;

	if (autoCommit) {
		instructions.push(`${step}. Commit your changes with a descriptive message`);
	}

	parts.push(`## Instructions\n${instructions.join("\n")}`);

	return parts.join("\n\n");
}

interface ParallelPromptOptions {
	task: string;
	progressFile: string;
	prdFile?: string;
	workDir?: string;
	skipTests?: boolean;
	skipLint?: boolean;
	browserEnabled?: "auto" | "true" | "false";
	allowCommit?: boolean;
}

/**
 * Build a prompt for parallel agent execution
 */
export function buildParallelPrompt(options: ParallelPromptOptions): string {
	const {
		task,
		progressFile,
		prdFile,
		workDir = process.cwd(),
		skipTests = false,
		skipLint = false,
		browserEnabled = "auto",
		allowCommit = true,
	} = options;

	// Parallel execution typically runs in a worktree
	const skillRoots = detectAgentSkills(workDir);
	const skillsSection =
		skillRoots.length > 0
			? `\n\nAgent Skills:\nThis repo includes skill/playbook docs:\n${skillRoots
					.map((p) => `- ${p}`)
					.join(
						"\n",
					)}\nBefore coding, read relevant skills. If your engine supports a \`skill\` tool, load them before implementing.`
			: "";

	const browserSection = isBrowserAvailable(browserEnabled)
		? `\n\n${getBrowserInstructions()}`
		: "";

	// Load rules from config
	const rules = loadRules(workDir);
	const codeChangeRules = [
		"Keep changes focused and minimal. Do not refactor unrelated code.",
		"One logical change per commit. If a task is too large, break it into subtasks.",
		"Write concise code. Avoid over-engineering.",
		"Don't leave dead code. Delete unused code completely.",
		"Quality over speed. Small steps compound into big progress.",
		...rules,
	];
	const rulesSection =
		codeChangeRules.length > 0
			? `\n\nRules (you MUST follow these):\n${codeChangeRules.map((r) => `- ${r}`).join("\n")}`
			: "";

	// Build boundaries section - combine system boundaries with user-defined boundaries
	// System boundaries come first to ensure they are prominently visible
	const userBoundaries = loadBoundaries(workDir);
	const systemBoundaries = [
		prdFile || "the PRD file",
		".ralphy/progress.txt",
		".ralphy-worktrees",
		".ralphy-sandboxes",
	];
	const allBoundaries = [...systemBoundaries, ...userBoundaries];
	const boundariesSection = `\n\nBoundaries - Do NOT modify:\n${allBoundaries.map((b) => `- ${b}`).join("\n")}\n\nDo NOT mark tasks complete - that will be handled separately.`;

	const instructions = ["1. Implement this specific task completely"];

	let step = 2;
	if (!skipTests) {
		instructions.push(`${step}. Write tests for the feature`);
		step++;
		instructions.push(`${step}. Run tests and ensure they pass before proceeding`);
		step++;
	}

	if (!skipLint) {
		instructions.push(`${step}. Run linting and ensure it passes`);
		step++;
	}

	instructions.push(`${step}. Update ${progressFile} with what you did`);
	step++;
	if (allowCommit) {
		instructions.push(`${step}. Commit your changes with a descriptive message`);
	} else {
		instructions.push(`${step}. Do NOT run git commit; changes will be collected automatically`);
	}

	return `You are working on a specific task. Focus ONLY on this task:

TASK: ${task}${rulesSection}${boundariesSection}${browserSection}${skillsSection}

Instructions:
${instructions.join("\n")}

Focus only on implementing: ${task}`;
}

/**
 * Build a planning prompt for task analysis
 *
 * This prompt guides the AI to analyze a task and produce structured output
 * including analysis, plan, files to modify, and optimization suggestions.
 */
export function buildPlanningPrompt(
	task: Task,
	_autoCommit?: boolean,
	fullTasksContext?: string,
	relevantFiles?: string[],
): string {
	// Build relevant files section if provided
	const relevantFilesSection =
		relevantFiles && relevantFiles.length > 0
			? `\nRELEVANT FILES (prioritize these in your analysis):\n${relevantFiles
					.slice(0, 30)
					.map((f) => `- ${f}`)
					.join("\n")}\n`
			: "";

	// Extract description from task body or use empty string
	const description = (task as { description?: string }).description || task.body || "";
	// Extract dependencies if they exist
	const dependencies = (task as { dependencies?: string[] }).dependencies || [];

	const prompt = `You are a senior engineering planner. Your job is to create a comprehensive plan for this task.

TASK: ${task.title || task.id}
${description ? `DESCRIPTION: ${description}` : ""}
${dependencies.length > 0 ? `DEPENDENCIES: ${dependencies.join(", ")}` : ""}
${relevantFilesSection}

${fullTasksContext ? `FULL PROJECT TASKS CONTEXT:\n${fullTasksContext}\n\n` : ""}

First, analyze this task thoroughly and provide structured output in this format:

<ANALYSIS>
 - Problem: [What is the actual problem being solved?]
 - Goal: [What is the desired end state?]
 - Complexity: [low/medium/high]
 - Risks: [Potential challenges or edge cases]
</ANALYSIS>

<PLAN>
1. [Step 1: What to do first]
2. [Step 2: Analysis or research needed]
3. [Step 3: Implementation approach]
4. [Step 4: Testing/validation]
5. [Step 5: Final integration or cleanup]
</PLAN>

<FILES>
path/to/file1.ext
path/to/file2.ext
...
</FILES>

<OPTIMIZATION>
 - Most efficient approach: [How to implement this optimally]
 - Key considerations: [Technical factors to remember]
 - Potential shortcuts: [Ways to accomplish this faster/better]
</OPTIMIZATION>

IMPORTANT INSTRUCTIONS FOR PLANNING PHASE:
1. You may use read/glob/grep tools to EXPLORE the codebase and understand the task
2. DO NOT write, edit, create, or modify any files during planning
3. DO NOT execute any implementation - this is a planning-only phase
4. After exploring, return the structured plan above in your final response
5. Your entire response must contain the <ANALYSIS>, <PLAN>, <FILES>, and <OPTIMIZATION> tags
6. Return ONLY the planning analysis, not partial results from tool exploration

Think step by step, explaining your reasoning clearly. Use tools to explore the codebase before finalizing your plan.`;

	return prompt;
}
