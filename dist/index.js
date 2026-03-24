"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.TaskDeletedError = exports.TaskWaitTimeout = exports.CommandError = exports.UserError = void 0;
exports.toInputEnvKey = toInputEnvKey;
exports.getInput = getInput;
exports.readBooleanInput = readBooleanInput;
exports.readIntegerInput = readIntegerInput;
exports.appendWorkflowFile = appendWorkflowFile;
exports.setOutput = setOutput;
exports.exportEnv = exportEnv;
exports.cleanNameFragment = cleanNameFragment;
exports.validateName = validateName;
exports.createTaskNameEntropy = createTaskNameEntropy;
exports.generateTaskName = generateTaskName;
exports.parseKeyValueLines = parseKeyValueLines;
exports.parseList = parseList;
exports.parseOptionalInteger = parseOptionalInteger;
exports.parseInteger = parseInteger;
exports.parseOptionalJsonObject = parseOptionalJsonObject;
exports.githubAnnotations = githubAnnotations;
exports.readInputs = readInputs;
exports.buildTaskManifest = buildTaskManifest;
exports.runCommand = runCommand;
exports.ensureKubectl = ensureKubectl;
exports.writeKubeconfig = writeKubeconfig;
exports.resolveManifestPath = resolveManifestPath;
exports.runKubectlJson = runKubectlJson;
exports.isNotFoundError = isNotFoundError;
exports.isNamespaceMismatchError = isNamespaceMismatchError;
exports.shouldApplyWithNamespace = shouldApplyWithNamespace;
exports.buildApplyTaskArgs = buildApplyTaskArgs;
exports.applyTask = applyTask;
exports.extractIdentity = extractIdentity;
exports.getTask = getTask;
exports.getTaskPhase = getTaskPhase;
exports.getTaskTTLSeconds = getTaskTTLSeconds;
exports.getWaitPollIntervalSeconds = getWaitPollIntervalSeconds;
exports.stringifyResultValue = stringifyResultValue;
exports.collectOutputs = collectOutputs;
exports.writeOutputs = writeOutputs;
exports.sleep = sleep;
exports.waitForTask = waitForTask;
exports.formatError = formatError;
exports.main = main;
const node_child_process_1 = require("node:child_process");
const node_crypto_1 = require("node:crypto");
const node_fs_1 = require("node:fs");
const node_os_1 = require("node:os");
const node_path_1 = require("node:path");
const TASK_RESOURCE = "tasks.kelos.dev";
const RFC1123_NAME = /^[a-z0-9]([-a-z0-9]*[a-z0-9])?$/;
const INTEGER_PATTERN = /^-?\d+$/;
const NOT_FOUND_PATTERN = /notfound|not found/i;
const MIN_TTL_POLL_INTERVAL_SECONDS = 0.5;
const TERMINAL_PHASES = new Set(["Succeeded", "Failed"]);
class UserError extends Error {
}
exports.UserError = UserError;
class CommandError extends Error {
    constructor(message, stdout = "", stderr = "", exitCode = null) {
        super(message);
        this.stdout = stdout;
        this.stderr = stderr;
        this.exitCode = exitCode;
    }
}
exports.CommandError = CommandError;
class TaskWaitTimeout extends Error {
    constructor(taskName, taskNamespace, timeoutSeconds, lastTask) {
        super(`timed out after ${timeoutSeconds}s waiting for Task ${taskName}`);
        this.taskName = taskName;
        this.taskNamespace = taskNamespace;
        this.lastTask = lastTask;
    }
}
exports.TaskWaitTimeout = TaskWaitTimeout;
class TaskDeletedError extends Error {
    constructor(taskName, taskNamespace, lastTask) {
        super(`Task ${taskName} disappeared before a terminal phase was observed. ` +
            "It may have been deleted by ttlSecondsAfterFinished before the next poll.");
        this.taskName = taskName;
        this.taskNamespace = taskNamespace;
        this.lastTask = lastTask;
    }
}
exports.TaskDeletedError = TaskDeletedError;
function toInputEnvKey(name) {
    return `INPUT_${name.replace(/ /g, "_").toUpperCase()}`;
}
function getInput(name, trim = true, env = process.env) {
    const value = env[toInputEnvKey(name)] ?? "";
    return trim ? value.trim() : value;
}
function readBooleanInput(name, defaultValue, env = process.env) {
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
function readIntegerInput(name, defaultValue, env = process.env) {
    const raw = getInput(name, true, env);
    if (!raw) {
        return defaultValue;
    }
    return parseInteger(raw, name);
}
function appendWorkflowFile(filePath, name, value) {
    if (!filePath) {
        return;
    }
    const safeName = name.replace(/[^A-Za-z0-9_]/g, "_").toUpperCase();
    const delimiter = `__KELOS_${safeName}_${Date.now()}__`;
    (0, node_fs_1.appendFileSync)(filePath, `${name}<<${delimiter}\n${value}\n${delimiter}\n`, "utf8");
}
function setOutput(name, value) {
    appendWorkflowFile(process.env.GITHUB_OUTPUT, name, value);
}
function exportEnv(name, value) {
    appendWorkflowFile(process.env.GITHUB_ENV, name, value);
}
function cleanNameFragment(value) {
    return value.toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/-+/g, "-").replace(/^-|-$/g, "");
}
function validateName(value) {
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
function createTaskNameEntropy(bytes = 4) {
    return (0, node_crypto_1.randomBytes)(bytes).toString("hex");
}
function generateTaskName(explicitName, prefix, runId, runAttempt, entropy = createTaskNameEntropy()) {
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
function parseKeyValueLines(raw) {
    if (!raw) {
        return {};
    }
    const parsed = {};
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
function parseList(raw) {
    if (!raw) {
        return [];
    }
    return raw.replace(/,/g, "\n").split(/\r?\n/).map((value) => value.trim()).filter(Boolean);
}
function parseOptionalInteger(raw, fieldName) {
    if (!raw.trim()) {
        return undefined;
    }
    return parseInteger(raw, fieldName);
}
function parseInteger(raw, fieldName) {
    const trimmed = raw.trim();
    if (!INTEGER_PATTERN.test(trimmed)) {
        throw new UserError(`${fieldName} must be an integer`);
    }
    return Number(trimmed);
}
function parseOptionalJsonObject(raw, fieldName) {
    if (!raw.trim()) {
        return undefined;
    }
    let parsed;
    try {
        parsed = JSON.parse(raw);
    }
    catch {
        throw new UserError(`${fieldName} must be valid JSON`);
    }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
        throw new UserError(`${fieldName} must decode to a JSON object`);
    }
    return parsed;
}
function githubAnnotations(env = process.env) {
    const annotations = {
        "kelos.dev/created-by": "kelos-action"
    };
    const mapping = {
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
function readInputs(env = process.env) {
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
function buildTaskManifest(inputs, env = process.env) {
    if (!inputs.type) {
        throw new UserError("type is required when task-file is not provided");
    }
    if (!inputs.prompt.trim()) {
        throw new UserError("prompt is required when task-file is not provided");
    }
    if (!inputs.credentialsSecret) {
        throw new UserError("credentials-secret is required when task-file is not provided");
    }
    const manifest = {
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
    const spec = manifest.spec;
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
function runCommand(command, args) {
    const result = (0, node_child_process_1.spawnSync)(command, args, { encoding: "utf8" });
    if (result.error) {
        const code = result.error.code;
        if (code === "ENOENT") {
            throw new CommandError(`${command} is required but was not found in PATH`);
        }
        throw new CommandError(result.error.message);
    }
    if (typeof result.status === "number" && result.status !== 0) {
        const stdout = result.stdout ?? "";
        const stderr = result.stderr ?? "";
        const message = stderr.trim() || stdout.trim() || `${command} exited with code ${result.status}`;
        throw new CommandError(message, stdout, stderr, result.status);
    }
    return result.stdout ?? "";
}
function ensureKubectl() {
    runCommand("kubectl", ["version", "--client"]);
}
function writeKubeconfig(rawKubeconfig) {
    if (!rawKubeconfig) {
        return;
    }
    const directory = (0, node_fs_1.mkdtempSync)((0, node_path_1.join)((0, node_os_1.tmpdir)(), "kelos-action-"));
    const filePath = (0, node_path_1.join)(directory, "kubeconfig");
    (0, node_fs_1.writeFileSync)(filePath, rawKubeconfig, "utf8");
    process.env.KUBECONFIG = filePath;
    exportEnv("KUBECONFIG", filePath);
}
function resolveManifestPath(inputs, env = process.env) {
    if (inputs.taskFile) {
        const manifestPath = (0, node_path_1.resolve)(inputs.taskFile);
        if (!(0, node_fs_1.existsSync)(manifestPath)) {
            throw new UserError(`task file not found: ${inputs.taskFile}`);
        }
        return manifestPath;
    }
    const directory = (0, node_fs_1.mkdtempSync)((0, node_path_1.join)((0, node_os_1.tmpdir)(), "kelos-action-"));
    const manifestPath = (0, node_path_1.join)(directory, "task.json");
    (0, node_fs_1.writeFileSync)(manifestPath, `${JSON.stringify(buildTaskManifest(inputs, env), null, 2)}\n`, "utf8");
    return manifestPath;
}
function runKubectlJson(args) {
    return JSON.parse(runCommand("kubectl", args));
}
function isNotFoundError(message) {
    return NOT_FOUND_PATTERN.test(message);
}
function isNamespaceMismatchError(message) {
    return /namespace from the provided object .* does not match the namespace /i.test(message);
}
function shouldApplyWithNamespace(manifestPath, namespace, runner = runCommand) {
    try {
        runner("kubectl", ["create", "--dry-run=client", "--validate=false", "-n", namespace, "-f", manifestPath, "-o", "json"]);
        return true;
    }
    catch (error) {
        if (error instanceof CommandError && isNamespaceMismatchError(error.message)) {
            return false;
        }
        throw error;
    }
}
function buildApplyTaskArgs(manifestPath, namespace, withNamespace) {
    const args = ["apply"];
    if (withNamespace) {
        args.push("-n", namespace);
    }
    args.push("-f", manifestPath, "-o", "json");
    return args;
}
function applyTask(manifestPath, namespace, withNamespace = true) {
    return runKubectlJson(buildApplyTaskArgs(manifestPath, namespace, withNamespace));
}
function extractIdentity(resource) {
    if (resource.apiVersion !== "kelos.dev/v1alpha1" || resource.kind !== "Task") {
        throw new UserError(`applied resource must be a kelos.dev/v1alpha1 Task, got ${resource.apiVersion ?? "<missing>"} ${resource.kind ?? "<missing>"}`);
    }
    const taskName = resource.metadata?.name;
    const taskNamespace = resource.metadata?.namespace || "default";
    if (!taskName) {
        throw new UserError("applied Task is missing metadata.name");
    }
    return { taskName, taskNamespace };
}
function getTask(taskName, taskNamespace) {
    return runKubectlJson(["get", TASK_RESOURCE, taskName, "-n", taskNamespace, "-o", "json"]);
}
function getTaskPhase(task) {
    return stringifyResultValue(task?.status?.phase);
}
function getTaskTTLSeconds(task) {
    const ttl = task?.spec?.["ttlSecondsAfterFinished"];
    return typeof ttl === "number" ? ttl : undefined;
}
function getWaitPollIntervalSeconds(requestedPollIntervalSeconds, task) {
    const ttlSeconds = getTaskTTLSeconds(task);
    if (ttlSeconds === undefined || ttlSeconds <= 0) {
        return requestedPollIntervalSeconds;
    }
    return Math.min(requestedPollIntervalSeconds, Math.max(MIN_TTL_POLL_INTERVAL_SECONDS, ttlSeconds / 2));
}
function stringifyResultValue(value) {
    return value === undefined || value === null ? "" : String(value);
}
function collectOutputs(task, taskName, taskNamespace) {
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
function writeOutputs(outputs) {
    for (const [key, value] of Object.entries(outputs)) {
        setOutput(key, value);
    }
}
function sleep(milliseconds) {
    return new Promise((resolvePromise) => setTimeout(resolvePromise, milliseconds));
}
async function waitForTask(taskName, taskNamespace, timeoutSeconds, pollIntervalSeconds, initialTask, fetchTask = getTask, sleepFn = sleep) {
    const deadline = Date.now() + timeoutSeconds * 1000;
    let lastTask = initialTask;
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
        }
        catch (error) {
            if (error instanceof CommandError) {
                const combined = `${error.stderr}\n${error.stdout}`;
                if (!isNotFoundError(combined)) {
                    throw error;
                }
                if (lastTask) {
                    throw new TaskDeletedError(taskName, taskNamespace, lastTask);
                }
            }
            else {
                throw error;
            }
        }
        if (Date.now() >= deadline) {
            throw new TaskWaitTimeout(taskName, taskNamespace, timeoutSeconds, lastTask);
        }
        await sleepFn(pollIntervalSeconds * 1000);
    }
}
function formatError(error) {
    return error instanceof Error ? error.message : String(error);
}
async function main(env = process.env) {
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
        throw new UserError("wait cannot be used when ttlSecondsAfterFinished is 0 because the Task may be deleted immediately after completion");
    }
    const effectivePollIntervalSeconds = getWaitPollIntervalSeconds(inputs.pollIntervalSeconds, appliedTask);
    if (inputs.wait && effectivePollIntervalSeconds !== inputs.pollIntervalSeconds) {
        console.log(`Reducing poll interval from ${inputs.pollIntervalSeconds}s to ${effectivePollIntervalSeconds}s ` +
            `to observe the Task before ttlSecondsAfterFinished=${taskTTLSeconds}s deletion.`);
    }
    try {
        if (inputs.wait) {
            taskForOutputs = await waitForTask(taskName, taskNamespace, inputs.timeoutSeconds, effectivePollIntervalSeconds, appliedTask);
        }
        else {
            try {
                taskForOutputs = getTask(taskName, taskNamespace);
            }
            catch (error) {
                console.warn(`Falling back to applied Task object for outputs: ${formatError(error)}`);
            }
        }
    }
    catch (error) {
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
