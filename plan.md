# Ralphy Performance Optimization Plan

## Problem
Users report ralphy is slow. PR #80 had good ideas but critical bugs (hard links break isolation).

## Scope: All Phases

---

## Phase 1: Quick Wins (Low risk, immediate impact)

### 1.1 In-Memory Task Caching

**Problem**: Every `getNextTask()` and `markComplete()` reads/writes the entire PRD file.

```typescript
// Current: markdown.ts:45-48 - reads file every call
async getNextTask(): Promise<Task | null> {
  const tasks = await this.getAllTasks();  // Full file read
  return tasks[0] || null;
}

// Current: markdown.ts:50-59 - read + write every call
async markComplete(id: string): Promise<void> {
  const content = readFileNormalized(this.filePath);  // Read
  // ... modify
  writeFileSync(this.filePath, lines.join("\n"));     // Write
}
```

**Solution**: Create `CachedTaskSource` wrapper that:
- Loads tasks once on construction
- Maintains in-memory state
- Batches `markComplete()` writes with debouncing
- Flushes on completion or process exit

**Files**:
- Create: `/cli/src/tasks/cached-task-source.ts`
- Modify: `/cli/src/tasks/index.ts` - export new class
- Modify: `/cli/src/execution/parallel.ts` - wrap taskSource with cache
- Modify: `/cli/src/execution/sequential.ts` - wrap taskSource with cache

### 1.2 Parallelize Worktree Cleanup

**Problem**: `parallel.ts:272-279` awaits each cleanup sequentially.

```typescript
// Current - sequential
for (const agentResult of results) {
  if (worktreeDir) {
    const cleanup = await cleanupAgentWorktree(...);  // Blocking
  }
}
```

**Solution**: Use `Promise.all()` for independent cleanup operations.

```typescript
// Optimized - parallel
const cleanupPromises = results
  .filter(r => r.worktreeDir)
  .map(r => cleanupAgentWorktree(r.worktreeDir, r.branchName, workDir));
await Promise.all(cleanupPromises);
```

**Files**:
- Modify: `/cli/src/execution/parallel.ts` - lines 272-279

---

## Phase 2: Merge Phase Optimization (Medium risk)

### 2.1 Parallel Preparation with Sequential Git Operations

**Problem**: `mergeCompletedBranches()` at lines 306-372 processes branches sequentially.

**Analysis**: Git has global repository locks, so true parallel merges are not possible. However, we can:
1. Parallelize the pre-merge analysis (conflict detection)
2. Parallelize post-merge cleanup (branch deletion)
3. Sort branches by conflict likelihood (merge clean ones first)

**Solution**: Split merge phase into stages:

```typescript
async function mergeCompletedBranches(
  branches: string[],
  targetBranch: string,
  engine: AIEngine,
  workDir: string,
): Promise<void> {
  // Stage 1: Parallel analysis - detect likely conflicts without merging
  const analysisTasks = branches.map(b => analyzePreMerge(b, targetBranch, workDir));
  const analyses = await Promise.all(analysisTasks);

  // Stage 2: Sort by conflict likelihood (merge clean ones first)
  const sortedBranches = sortByConflictLikelihood(branches, analyses);

  // Stage 3: Sequential merges (git locking requires this)
  const merged: string[] = [];
  const failed: string[] = [];

  for (const branch of sortedBranches) {
    // ... existing merge logic
  }

  // Stage 4: Parallel cleanup of merged branches
  const deletionPromises = merged.map(b => deleteLocalBranch(b, workDir, true));
  await Promise.all(deletionPromises);
}

// Pre-merge analysis uses `git diff` which doesn't require locks
async function analyzePreMerge(branch: string, target: string, workDir: string): Promise<{
  filesChanged: string[];
  conflictLikelihood: 'low' | 'medium' | 'high';
}> {
  const git = simpleGit(workDir);
  const diff = await git.diff([`${target}...${branch}`, '--name-only']);
  // Analyze for potential conflicts based on file overlap
}
```

**Files**:
- Modify: `/cli/src/git/merge.ts` - Add `analyzePreMerge()` function
- Modify: `/cli/src/execution/parallel.ts` - Update `mergeCompletedBranches()`

---

## Phase 3: Lightweight Sandbox Mode (Higher risk, big payoff)

### 3.1 Copy-on-Write Sandbox Architecture

**Problem**: Git worktrees copy the entire repo for each agent. For a 1GB repo with 5 agents, that's 5GB of disk I/O.

**PR #80 Bug**: They used hard links, which share inodes. When the AI modifies a file, it modifies the original. This breaks isolation completely.

**Correct Solution**: Use a combination of:
1. **Symlinks for read-only dependencies** (node_modules, .git, vendor, etc.)
2. **Selective file copies** for files the agent might modify
3. **Copy-on-write overlay** (or simple copy) for source directories

```typescript
// New file: /cli/src/execution/sandbox.ts

interface SandboxOptions {
  originalDir: string;
  sandboxDir: string;
  readOnlySymlinks: string[];  // Patterns like 'node_modules', '.git', 'vendor'
  copyPatterns: string[];       // Patterns like 'src/**', '*.config.*'
}

export async function createSandbox(options: SandboxOptions): Promise<string> {
  const { originalDir, sandboxDir, readOnlySymlinks, copyPatterns } = options;

  // 1. Create sandbox directory
  mkdirSync(sandboxDir, { recursive: true });

  // 2. Create symlinks for read-only resources (CRITICAL: symlink, NOT hard link)
  for (const pattern of readOnlySymlinks) {
    const originalPath = join(originalDir, pattern);
    const sandboxPath = join(sandboxDir, pattern);
    if (existsSync(originalPath)) {
      symlinkSync(originalPath, sandboxPath);
    }
  }

  // 3. Copy files that might be modified
  for (const pattern of copyPatterns) {
    await copyByPattern(originalDir, sandboxDir, pattern);
  }

  // 4. Initialize minimal git state for commits
  await initSandboxGit(sandboxDir, originalDir);

  return sandboxDir;
}

// Copy back only modified files
export async function syncSandboxChanges(
  sandboxDir: string,
  originalDir: string
): Promise<string[]> {
  const modifiedFiles: string[] = [];
  // Compare and copy back only changed files
  return modifiedFiles;
}
```

**Key Safety Measures**:
1. **Never symlink source directories** - always copy `src/`, `lib/`, etc.
2. **Mark symlinks as read-only** in the sandbox
3. **Verify isolation** before agent execution with a test write
4. **Fall back to worktrees** if sandbox creation fails

**Configuration in `.ralphy/config.yaml`**:
```yaml
sandbox:
  enabled: true  # false uses git worktrees (default: false for backward compat)
  readOnlySymlinks:
    - node_modules
    - .git
    - vendor
    - .venv
    - target  # Rust
    - build
  copyPatterns:
    - src/**
    - lib/**
    - "*.config.*"
    - "*.json"
    - "*.yaml"
    - "*.md"
```

**Files**:
- Create: `/cli/src/execution/sandbox.ts`
- Create: `/cli/src/execution/sandbox-git.ts` - Git operations for sandboxes
- Modify: `/cli/src/execution/parallel.ts` - Add sandbox mode option
- Modify: `/cli/src/config/types.ts` - Add sandbox config schema
- Modify: `/cli/src/cli/args.ts` - Add `--sandbox` flag

---

## Phase 4: Advanced Optimizations (High complexity, experimental)

### 4.1 LLM-Predicted File Scope

**Concept**: Before creating a sandbox, ask the LLM to predict which files the task will likely modify.

```typescript
interface TaskScope {
  likelyFiles: string[];      // Files that will probably be modified
  possibleFiles: string[];    // Files that might be touched
  readOnlyDeps: string[];     // Dependencies to symlink
}

async function predictTaskScope(
  task: Task,
  engine: AIEngine,
  projectStructure: string[]
): Promise<TaskScope> {
  const prompt = `Given this task and project structure, predict which files will be modified:
Task: ${task.title}
Files: ${projectStructure.join('\n')}

Return JSON with:
- likelyFiles: files that will definitely be changed
- possibleFiles: files that might be changed
- readOnlyDeps: directories that are dependencies (node_modules, etc)`;

  const result = await engine.execute(prompt, workDir);
  return parseTaskScope(result.response);
}
```

**Risk Mitigation**: If LLM prediction misses files, the sandbox should handle it gracefully.

**Files**:
- Create: `/cli/src/execution/planning.ts`
- Modify: `/cli/src/execution/sandbox.ts` - Use predictions for selective copying
- Modify: `/cli/src/cli/args.ts` - Add `--planning-model` flag for cheaper planning

### 4.2 DSatur Graph Coloring for Conflict Minimization

**Concept**: Schedule tasks based on file dependencies to minimize merge conflicts.

```typescript
interface TaskDependencyGraph {
  nodes: Task[];
  edges: Array<[Task, Task, number]>;  // [task1, task2, conflictWeight]
}

function buildDependencyGraph(tasks: Task[], scopes: Map<Task, TaskScope>): TaskDependencyGraph {
  // Create edges between tasks that touch same files
}

function scheduleWithDSatur(graph: TaskDependencyGraph, maxParallel: number): Task[][] {
  // DSatur algorithm: prioritize nodes by saturation degree
  // Returns batches of non-conflicting tasks
}
```

**Files**:
- Create: `/cli/src/execution/graph-coloring.ts`
- Modify: `/cli/src/execution/parallel.ts` - Use DSatur for batch scheduling

---

## Files Summary

| Phase | File | Change |
|-------|------|--------|
| 1 | `/cli/src/tasks/cached-task-source.ts` | **Create** - CachedTaskSource wrapper |
| 1 | `/cli/src/tasks/index.ts` | Export CachedTaskSource |
| 1 | `/cli/src/execution/parallel.ts` | Parallel cleanup |
| 1 | `/cli/src/execution/sequential.ts` | Use cached task source |
| 2 | `/cli/src/git/merge.ts` | Add `analyzePreMerge()`, parallel deletion |
| 2 | `/cli/src/execution/parallel.ts` | Optimized merge phase |
| 3 | `/cli/src/execution/sandbox.ts` | **Create** - Sandbox creation/sync |
| 3 | `/cli/src/execution/sandbox-git.ts` | **Create** - Git ops for sandboxes |
| 3 | `/cli/src/config/types.ts` | Sandbox config schema |
| 3 | `/cli/src/cli/args.ts` | Add `--sandbox` flag |
| 4 | `/cli/src/execution/planning.ts` | **Create** - LLM file prediction |
| 4 | `/cli/src/execution/graph-coloring.ts` | **Create** - DSatur algorithm |

---

## Verification

1. **Phase 1**: Run `ralphy --parallel` with 10+ tasks, compare time before/after
2. **Phase 2**: Run parallel execution with 5+ branches, verify merge phase is faster
3. **Phase 3**: Run with `--sandbox` flag, verify isolation (changes don't leak)
4. **Phase 4**: Run with `--planning-model`, verify predictions reduce copy overhead
5. **All phases**: Run test suite to ensure no regressions:
   ```bash
   cd cli && bun test
   ```
