import YAML from "yaml";
import { parseCSV } from "./csv.ts";

/**
 * Escape a value for CSV output
 */
function escapeCSV(value: string): string {
	if (value.includes(",") || value.includes('"') || value.includes("\n")) {
		return `"${value.replace(/"/g, '""')}"`;
	}
	return value;
}

/**
 * Convert rows to CSV string
 */
function toCSV(rows: string[][]): string {
	return rows.map((row) => row.map(escapeCSV).join(",")).join("\n");
}

/**
 * Truncate description to save tokens
 */
function truncateDesc(desc: string | undefined, maxLen = 80): string {
	if (!desc) return "";
	const clean = desc.replace(/\s+/g, " ").trim();
	if (clean.length <= maxLen) return clean;
	return `${clean.slice(0, maxLen - 3)}...`;
}

interface YamlTask {
	title: string;
	completed?: boolean;
	parallel_group?: number;
	description?: string;
}

interface YamlTaskFile {
	tasks: YamlTask[];
}

/**
 * Convert YAML task file content to CSV format
 */
export function yamlToCsv(yamlContent: string): string {
	const data = YAML.parse(yamlContent) as YamlTaskFile;
	const tasks = data.tasks || [];

	const rows: string[][] = [["id", "title", "done", "group", "desc"]];
	for (let i = 0; i < tasks.length; i++) {
		const t = tasks[i];
		rows.push([
			String(i + 1),
			t.title || "",
			t.completed ? "1" : "0",
			String(t.parallel_group || 0),
			truncateDesc(t.description),
		]);
	}
	return toCSV(rows);
}

/**
 * Convert Markdown task file content to CSV format
 */
export function mdToCsv(mdContent: string): string {
	const lines = mdContent.replace(/\r\n/g, "\n").split("\n");
	const rows: string[][] = [["id", "title", "done", "group", "desc"]];

	let id = 1;
	for (const line of lines) {
		const incompleteMatch = line.match(/^- \[ \] (.+)$/);
		if (incompleteMatch) {
			rows.push([String(id), incompleteMatch[1].trim(), "0", "0", ""]);
			id++;
			continue;
		}

		const completeMatch = line.match(/^- \[x\] (.+)$/i);
		if (completeMatch) {
			rows.push([String(id), completeMatch[1].trim(), "1", "0", ""]);
			id++;
		}
	}

	return toCSV(rows);
}

interface JsonTask {
	id?: string | number;
	title: string;
	completed?: boolean;
	parallel_group?: number;
	parallelGroup?: number;
	description?: string;
	body?: string;
}

/**
 * Convert JSON task file content to CSV format
 */
export function jsonToCsv(jsonContent: string): string {
	const data = JSON.parse(jsonContent);
	const tasks: JsonTask[] = Array.isArray(data) ? data : data.tasks || [];

	const rows: string[][] = [["id", "title", "done", "group", "desc"]];
	for (let i = 0; i < tasks.length; i++) {
		const t = tasks[i];
		rows.push([
			String(t.id || i + 1),
			t.title || "",
			t.completed ? "1" : "0",
			String(t.parallel_group || t.parallelGroup || 0),
			truncateDesc(t.description || t.body),
		]);
	}
	return toCSV(rows);
}

// Re-export parseCSV for use by other modules
export { parseCSV } from "./csv.ts";
