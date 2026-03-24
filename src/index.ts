import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { appendFileSync, existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

export interface ActionInputs {
  kubeconfig: string;
  namespace: string;
  taskFile: string;
  taskName: string;
  taskNamePrefix: string;
  type: string;
  prompt: string;
  credentialsSecret: string;
  credentialsType: string;
  model: string;
  image: string;
  workspace: string;
  agentConfig: string;
  branch: string;
  dependsOn: string;
  ttlSecondsAfterFinished: string;
  podOverridesJson: string;
  labels: string;
  annotations: string;
  wait: boolean;
  timeoutSeconds: number;
  pollIntervalSeconds: number;
}

export interface TaskResource {
  apiVersion?: string;
  kind?: string;
  metadata?: {
    name?: string;
    namespace?: string;
    labels?: Record<string, string>;
    annotations?: Record<string, string>;
  };
  spec?: Record<string, unknown>;
  status?: {
    phase?: string;
    message?: string;
    jobName?: string;
    podName?: string;
    results?: Record<string, unknown>;
  };
}

export interface TaskOutputs {
  task_name: string;
  task_namespace: string;
  phase: string;
  message: string;
  job_name: string;
  pod_name: string;
  branch: string;
  commit: string;
  base_branch: string;
  pr: string;
  cost_usd: string;
  input_tokens: string;
  output_tokens: string;
  results_json: string;
}

const TASK_RESOURCE = "tasks.kelos.dev";
const RFC1123_NAME = /^[a-z0-9]([-a-z0-9]*[a-z0-9])?$/;
const INTEGER_PATTERN = /^-?\d+$/;
const NOT_FOUND_PATTERN = /notfound|not found/i;
const MIN_TTL_POLL_INTERVAL_SECONDS = 0.5;
const TERMINAL_PHASES = new Set(["Succeeded", "Failed"]);

export class UserError extends Error {}

export class CommandError extends Error {
  stdout: string;
  stderr: string;
  exitCode: number | null;

  constructor(message: string, stdout = "", stderr = "", exitCode: number | null = null) {
    super(message);
    this.stdout = stdout;
    this.stderr = stderr;
    this.exitCode = exitCode;
  }
}

export class TaskWaitTimeout extends Error {
  taskName: string;
  taskNamespace: string;
  lastTask?: TaskResource;

  constructor(taskName: string, taskNamespace: string, timeoutSeconds: number, lastTask?: TaskResource) {
    super(`timed out after ${timeoutSeconds}s waiting for Task ${taskName}`);
    this.taskName = taskName;
    this.taskNamespace = taskNamespace;
    this.lastTask = lastTask;
  }
}

export class TaskDeletedError extends Error {
  taskName: string;
  taskNamespace: string;
  lastTask?: TaskResource;

  constructor(taskName: string, taskNamespace: string, lastTask?: TaskResource) {
    super(
      `Task ${taskName} disappeared before a terminal phase was observed. ` +
      "It may have been deleted by ttlSecondsAfterFinished before the next poll."
    );
    this.taskName = taskName;
    this.taskNamespace = taskNamespace;
    this.lastTask = lastTask;
  }
}

export function toInputEnvKey(name: string): string {
  return `INPUT_${name.replace(/ /g, "_").toUpperCase()}`;
}

export function getInput(name: string, trim = true, env: NodeJS.ProcessEnv = process.env): string {
  const value = env[toInputEnvKey(name)] ?? "";
  return trim ? value.trim() : value;
}

export function readBooleanInput(name: string, defaultValue: boolean, env: NodeJS.ProcessEnv = process.env): boolean {
  const raw = getInput(name, true, env);
  if (!raw) {
    return defaultValue;
  }
  if (raw === "true") {
    return true;
  }
  if (raw === "false") {
    return false;
  }
  throw new UserError(`${name} must be "true" or "false"`);
}

export function readIntegerInput(name: string, defaultValue: number, env: NodeJS.ProcessEnv = process.env): number {
  const raw = getInput(name, true, env);
  if (!raw) {
    return defaultValue;
  }
  return parseInteger(raw, name);
}

export function appendWorkflowFile(filePath: string | undefined, name: string, value: string): void {
  if (!filePath) {
    return;
  }
  const safeName = name.replace(/[^A-Za-z0-9_]/g, "_").toUpperCase();
  const delimiter = `__KELOS_${safeName}_${Date.now()}__`;
  appendFileSync(filePath, `${name}<<${delimiter}\n${value}\n${delimiter}\n`, "utf8");
}

export function setOutput(name: string, value: string): void {
  appendWorkflowFile(process.env.GITHUB_OUTPUT, name, value);
}

export function exportEnv(name: string, value: string): void {
  appendWorkflowFile(process.env.GITHUB_ENV, name, value);
}

export function cleanNameFragment(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/-+/g, "-").replace(/^-|-$/g, "");
}

export function validateName(value: string): string {
  if (!value) {
    throw new UserError("task name must not be empty");
  }
  if (value.length > 63) {
    throw new UserError(`task name "${value}" exceeds the Kubernetes 63 character limit`);
  }
  if (!RFC1123_NAME.test(value)) {
    throw new UserError(`task name "${value}" must match RFC 1123 label syntax`);
  }
  return value;
}

export function createTaskNameEntropy(bytes = 4): string {
  return randomBytes(bytes).toString("hex");
}

export function generateTaskName(
  explicitName: string,
  prefix: string,
  runId: string,
  runAttempt: string,
  entropy = createTaskNameEntropy()
): string {
  if (explicitName) {
    return validateName(explicitName);
  }

  const cleanedPrefix = cleanNameFragment(prefix || "kelos-task") || "kelos-task";
  const suffixParts = [cleanNameFragment(runId), cleanNameFragment(runAttempt), cleanNameFragment(entropy)].filter(Boolean);

  if (suffixParts.length === 0) {
    return validateName(cleanedPrefix.slice(0, 63).replace(/-$/g, ""));
  }

  const suffix = suffixParts.join("-");
  const availablePrefixLength = 63 - suffix.length - 1;
  const trimmedPrefix = cleanedPrefix.slice(0, availablePrefixLength).replace(/-$/g, "") || "kelos";
  return validateName(`${trimmedPrefix}-${suffix}`);
}

export function parseKeyValueLines(raw: string): Record<string, string> {
  if (!raw) {
    return {};
  }

  const parsed: Record<string, string> = {};
  for (const [index, line] of raw.split(/\r?\n/).entries()) {
    const trimmed = line.trim();
    if (!trimmed) {
      continue;
    }
    const separator = trimmed.indexOf("=");
    if (separator === -1) {
      throw new UserError(`expected key=value on line ${index + 1}, got "${trimmed}"`);
    }
    const key = trimmed.slice(0, separator).trim();
    const value = trimmed.slice(separator + 1).trim();
    if (!key) {
      throw new UserError(`label or annotation key is empty on line ${index + 1}`);
    }
    parsed[key] = value;
  }
  return parsed;
}

export function parseList(raw: string): string[] {
  if (!raw) {
    return [];
  }
  return raw.replace(/,/g, "\n").split(/\r?\n/).map((value) => value.trim()).filter(Boolean);
}

export function parseOptionalInteger(raw: string, fieldName: string): number | undefined {
  if (!raw.trim()) {
    return undefined;
  }
  return parseInteger(raw, fieldName);
}

export function parseInteger(raw: string, fieldName: string): number {
  const trimmed = raw.trim();
  if (!INTEGER_PATTERN.test(trimmed)) {
    throw new UserError(`${fieldName} must be an integer`);
  }
  return Number(trimmed);
}

export function parseOptionalJsonObject(raw: string, fieldName: string): Record<string, unknown> | undefined {
  if (!raw.trim()) {
    return undefined;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new UserError(`${fieldName} must be valid JSON`);
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new UserError(`${fieldName} must decode to a JSON object`);
  }
  return parsed as Record<string, unknown>;
}

export function githubAnnotations(env: NodeJS.ProcessEnv = process.env): Record<string, string> {
  const annotations: Record<string, string> = {
    "kelos.dev/created-by": "kelos-action"
  };

  const mapping: Record<string, string> = {
    "kelos.dev/github-repository": "GITHUB_REPOSITORY",
    "kelos.dev/github-workflow": "GITHUB_WORKFLOW",
    "kelos.dev/github-run-id": "GITHUB_RUN_ID",
    "kelos.dev/github-run-attempt": "GITHUB_RUN_ATTEMPT",
    "kelos.dev/github-job": "GITHUB_JOB",
    "kelos.dev/github-sha": "GITHUB_SHA",
    "kelos.dev/github-ref": "GITHUB_REF",
    "kelos.dev/github-actor": "GITHUB_ACTOR",
    "kelos.dev/github-server-url": "GITHUB_SERVER_URL"
  };

  for (const [annotationKey, envKey] of Object.entries(mapping)) {
    const value = env[envKey];
    if (value) {
      annotations[annotationKey] = value;
    }
  }

  const serverUrl = env.GITHUB_SERVER_URL;
  const repository = env.GITHUB_REPOSITORY;
  const runId = env.GITHUB_RUN_ID;
  if (serverUrl && repository && runId) {
    annotations["kelos.dev/github-run-url"] = `${serverUrl.replace(/\/$/, "")}/${repository}/actions/runs/${runId}`;
  }

  return annotations;
}

export function readInputs(env: NodeJS.ProcessEnv = process.env): ActionInputs {
  return {
    kubeconfig: getInput("kubeconfig", false, env),
    namespace: getInput("namespace", true, env) || "default",
    taskFile: getInput("task-file", true, env),
    taskName: getInput("task-name", true, env),
    taskNamePrefix: getInput("task-name-prefix", true, env) || "kelos-task",
    type: getInput("type", true, env),
    prompt: getInput("prompt", false, env),
    credentialsSecret: getInput("credentials-secret", true, env),
    credentialsType: getInput("credentials-type", true, env) || "oauth",
    model: getInput("model", true, env),
    image: getInput("image", true, env),
    workspace: getInput("workspace", true, env),
    agentConfig: getInput("agent-config", true, env),
    branch: getInput("branch", true, env),
    dependsOn: getInput("depends-on", false, env),
    ttlSecondsAfterFinished: getInput("ttl-seconds-after-finished", true, env),
    podOverridesJson: getInput("pod-overrides-json", false, env),
    labels: getInput("labels", false, env),
    annotations: getInput("annotations", false, env),
    wait: readBooleanInput("wait", false, env),
    timeoutSeconds: readIntegerInput("timeout-seconds", 1800, env),
    pollIntervalSeconds: readIntegerInput("poll-interval-seconds", 10, env)
  };
}

export function buildTaskManifest(inputs: ActionInputs, env: NodeJS.ProcessEnv = process.env): TaskResource {
  if (!inputs.type) {
    throw new UserError("type is required when task-file is not provided");
  }
  if (!inputs.prompt.trim()) {
    throw new UserError("prompt is required when task-file is not provided");
  }
  if (!inputs.credentialsSecret) {
    throw new UserError("credentials-secret is required when task-file is not provided");
  }

  const manifest: TaskResource = {
    apiVersion: "kelos.dev/v1alpha1",
    kind: "Task",
    metadata: {
      name: generateTaskName(inputs.taskName, inputs.taskNamePrefix, env.GITHUB_RUN_ID ?? "", env.GITHUB_RUN_ATTEMPT ?? ""),
      namespace: inputs.namespace,
      labels: {
        "app.kubernetes.io/managed-by": "github-actions",
        "app.kubernetes.io/name": "kelos-task",
        ...parseKeyValueLines(inputs.labels)
      },
      annotations: {
        ...githubAnnotations(env),
        ...parseKeyValueLines(inputs.annotations)
      }
    },
    spec: {
      type: inputs.type,
      prompt: inputs.prompt,
      credentials: {
        type: inputs.credentialsType,
        secretRef: {
          name: inputs.credentialsSecret
        }
      }
    }
  };

  const spec = manifest.spec as Record<string, unknown>;
  if (inputs.model) {
    spec.model = inputs.model;
  }
  if (inputs.image) {
    spec.image = inputs.image;
  }
  if (inputs.workspace) {
    spec.workspaceRef = { name: inputs.workspace };
  }
  if (inputs.agentConfig) {
    spec.agentConfigRef = { name: inputs.agentConfig };
  }
  if (inputs.branch) {
    spec.branch = inputs.branch;
  }

  const dependsOn = parseList(inputs.dependsOn);
  if (dependsOn.length > 0) {
    spec.dependsOn = dependsOn;
  }

  const ttlSecondsAfterFinished = parseOptionalInteger(inputs.ttlSecondsAfterFinished, "ttl-seconds-after-finished");
  if (ttlSecondsAfterFinished !== undefined) {
    spec.ttlSecondsAfterFinished = ttlSecondsAfterFinished;
  }

  const podOverrides = parseOptionalJsonObject(inputs.podOverridesJson, "pod-overrides-json");
  if (podOverrides !== undefined) {
    spec.podOverrides = podOverrides;
  }

  return manifest;
}

export function runCommand(command: string, args: string[]): string {
  const result = spawnSync(command, args, { encoding: "utf8" });

  if (result.error) {
    const code = (result.error as NodeJS.ErrnoException).code;
    if (code === "ENOENT") {
      throw new CommandError(`${command} is required but was not found in PATH`);
    }
    throw new CommandError((result.error as Error).message);
  }

  if (typeof result.status === "number" && result.status !== 0) {
    const stdout = result.stdout ?? "";
    const stderr = result.stderr ?? "";
    const message = stderr.trim() || stdout.trim() || `${command} exited with code ${result.status}`;
    throw new CommandError(message, stdout, stderr, result.status);
  }

  return result.stdout ?? "";
}

export function ensureKubectl(): void {
  runCommand("kubectl", ["version", "--client"]);
}

export function writeKubeconfig(rawKubeconfig: string): void {
  if (!rawKubeconfig) {
    return;
  }
  const directory = mkdtempSync(join(tmpdir(), "kelos-action-"));
  const filePath = join(directory, "kubeconfig");
  writeFileSync(filePath, rawKubeconfig, "utf8");
  process.env.KUBECONFIG = filePath;
  exportEnv("KUBECONFIG", filePath);
}

export function resolveManifestPath(inputs: ActionInputs, env: NodeJS.ProcessEnv = process.env): string {
  if (inputs.taskFile) {
    const manifestPath = resolve(inputs.taskFile);
    if (!existsSync(manifestPath)) {
      throw new UserError(`task file not found: ${inputs.taskFile}`);
    }
    return manifestPath;
  }

  const directory = mkdtempSync(join(tmpdir(), "kelos-action-"));
  const manifestPath = join(directory, "task.json");
  writeFileSync(manifestPath, `${JSON.stringify(buildTaskManifest(inputs, env), null, 2)}\n`, "utf8");
  return manifestPath;
}

export function runKubectlJson(args: string[]): TaskResource {
  return JSON.parse(runCommand("kubectl", args)) as TaskResource;
}

export function isNotFoundError(message: string): boolean {
  return NOT_FOUND_PATTERN.test(message);
}

export function isNamespaceMismatchError(message: string): boolean {
  return /namespace from the provided object .* does not match the namespace /i.test(message);
}

export function shouldApplyWithNamespace(
  manifestPath: string,
  namespace: string,
  runner: (command: string, args: string[]) => string = runCommand
): boolean {
  try {
    runner("kubectl", ["create", "--dry-run=client", "--validate=false", "-n", namespace, "-f", manifestPath, "-o", "json"]);
    return true;
  } catch (error) {
    if (error instanceof CommandError && isNamespaceMismatchError(error.message)) {
      return false;
    }
    throw error;
  }
}

export function buildApplyTaskArgs(manifestPath: string, namespace: string, withNamespace: boolean): string[] {
  const args = ["apply"];
  if (withNamespace) {
    args.push("-n", namespace);
  }
  args.push("-f", manifestPath, "-o", "json");
  return args;
}

export function applyTask(manifestPath: string, namespace: string, withNamespace = true): TaskResource {
  return runKubectlJson(buildApplyTaskArgs(manifestPath, namespace, withNamespace));
}

export function extractIdentity(resource: TaskResource): { taskName: string; taskNamespace: string } {
  if (resource.apiVersion !== "kelos.dev/v1alpha1" || resource.kind !== "Task") {
    throw new UserError(
      `applied resource must be a kelos.dev/v1alpha1 Task, got ${resource.apiVersion ?? "<missing>"} ${resource.kind ?? "<missing>"}`
    );
  }
  const taskName = resource.metadata?.name;
  const taskNamespace = resource.metadata?.namespace || "default";
  if (!taskName) {
    throw new UserError("applied Task is missing metadata.name");
  }
  return { taskName, taskNamespace };
}

export function getTask(taskName: string, taskNamespace: string): TaskResource {
  return runKubectlJson(["get", TASK_RESOURCE, taskName, "-n", taskNamespace, "-o", "json"]);
}

export function getTaskPhase(task: TaskResource | undefined): string {
  return stringifyResultValue(task?.status?.phase);
}

export function getTaskTTLSeconds(task: TaskResource | undefined): number | undefined {
  const ttl = task?.spec?.["ttlSecondsAfterFinished"];
  return typeof ttl === "number" ? ttl : undefined;
}

export function getWaitPollIntervalSeconds(requestedPollIntervalSeconds: number, task: TaskResource | undefined): number {
  const ttlSeconds = getTaskTTLSeconds(task);
  if (ttlSeconds === undefined || ttlSeconds <= 0) {
    return requestedPollIntervalSeconds;
  }
  return Math.min(requestedPollIntervalSeconds, Math.max(MIN_TTL_POLL_INTERVAL_SECONDS, ttlSeconds / 2));
}

export function stringifyResultValue(value: unknown): string {
  return value === undefined || value === null ? "" : String(value);
}

export function collectOutputs(task: TaskResource, taskName: string, taskNamespace: string): TaskOutputs {
  const status = task.status ?? {};
  const results = status.results ?? {};

  return {
    task_name: taskName,
    task_namespace: taskNamespace,
    phase: stringifyResultValue(status.phase),
    message: stringifyResultValue(status.message),
    job_name: stringifyResultValue(status.jobName),
    pod_name: stringifyResultValue(status.podName),
    branch: stringifyResultValue(results["branch"]),
    commit: stringifyResultValue(results["commit"]),
    base_branch: stringifyResultValue(results["base-branch"]),
    pr: stringifyResultValue(results["pr"]),
    cost_usd: stringifyResultValue(results["cost-usd"]),
    input_tokens: stringifyResultValue(results["input-tokens"]),
    output_tokens: stringifyResultValue(results["output-tokens"]),
    results_json: JSON.stringify(results)
  };
}

export function writeOutputs(outputs: TaskOutputs): void {
  for (const [key, value] of Object.entries(outputs)) {
    setOutput(key, value);
  }
}

export function sleep(milliseconds: number): Promise<void> {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, milliseconds));
}

export async function waitForTask(
  taskName: string,
  taskNamespace: string,
  timeoutSeconds: number,
  pollIntervalSeconds: number,
  initialTask?: TaskResource,
  fetchTask: (taskName: string, taskNamespace: string) => TaskResource = getTask,
  sleepFn: (milliseconds: number) => Promise<void> = sleep
): Promise<TaskResource> {
  const deadline = Date.now() + timeoutSeconds * 1000;
  let lastTask: TaskResource | undefined = initialTask;
  let lastPhase = getTaskPhase(initialTask);

  while (true) {
    try {
      const task = fetchTask(taskName, taskNamespace);
      lastTask = task;
      const phase = getTaskPhase(task);
      if (phase !== lastPhase) {
        console.log(`Task ${taskName} phase: ${phase || "<unset>"}`);
        lastPhase = phase;
      }
      if (TERMINAL_PHASES.has(phase)) {
        return task;
      }
    } catch (error) {
      if (error instanceof CommandError) {
        const combined = `${error.stderr}\n${error.stdout}`;
        if (!isNotFoundError(combined)) {
          throw error;
        }
        if (lastTask) {
          throw new TaskDeletedError(taskName, taskNamespace, lastTask);
        }
      } else {
        throw error;
      }
    }

    if (Date.now() >= deadline) {
      throw new TaskWaitTimeout(taskName, taskNamespace, timeoutSeconds, lastTask);
    }
    await sleepFn(pollIntervalSeconds * 1000);
  }
}

export function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export async function main(env: NodeJS.ProcessEnv = process.env): Promise<void> {
  const inputs = readInputs(env);

  if (inputs.kubeconfig) {
    writeKubeconfig(inputs.kubeconfig);
  }

  ensureKubectl();
  const manifestPath = resolveManifestPath(inputs, env);
  const applyWithNamespace = inputs.taskFile ? shouldApplyWithNamespace(manifestPath, inputs.namespace) : true;
  const appliedTask = applyTask(manifestPath, inputs.namespace, applyWithNamespace);
  const { taskName, taskNamespace } = extractIdentity(appliedTask);

  setOutput("task_name", taskName);
  setOutput("task_namespace", taskNamespace);

  let taskForOutputs = appliedTask;
  const taskTTLSeconds = getTaskTTLSeconds(appliedTask);
  if (inputs.wait && taskTTLSeconds === 0) {
    throw new UserError(
      "wait cannot be used when ttlSecondsAfterFinished is 0 because the Task may be deleted immediately after completion"
    );
  }

  const effectivePollIntervalSeconds = getWaitPollIntervalSeconds(inputs.pollIntervalSeconds, appliedTask);
  if (inputs.wait && effectivePollIntervalSeconds !== inputs.pollIntervalSeconds) {
    console.log(
      `Reducing poll interval from ${inputs.pollIntervalSeconds}s to ${effectivePollIntervalSeconds}s ` +
      `to observe the Task before ttlSecondsAfterFinished=${taskTTLSeconds}s deletion.`
    );
  }

  try {
    if (inputs.wait) {
      taskForOutputs = await waitForTask(
        taskName,
        taskNamespace,
        inputs.timeoutSeconds,
        effectivePollIntervalSeconds,
        appliedTask
      );
    } else {
      try {
        taskForOutputs = getTask(taskName, taskNamespace);
      } catch (error) {
        console.warn(`Falling back to applied Task object for outputs: ${formatError(error)}`);
      }
    }
  } catch (error) {
    if ((error instanceof TaskWaitTimeout || error instanceof TaskDeletedError) && error.lastTask) {
      writeOutputs(collectOutputs(error.lastTask, error.taskName, error.taskNamespace));
    }
    throw error;
  }

  const outputs = collectOutputs(taskForOutputs, taskName, taskNamespace);
  writeOutputs(outputs);

  if (inputs.wait && outputs.phase === "Failed") {
    throw new UserError(`Task ${taskName} finished in Failed phase`);
  }
}

if (require.main === module) {
  main().catch((error) => {
    console.error(formatError(error));
    process.exit(1);
  });
}
