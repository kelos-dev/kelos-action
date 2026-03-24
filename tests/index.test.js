const test = require("node:test");
const assert = require("node:assert/strict");

const {
  CommandError,
  TaskDeletedError,
  UserError,
  buildApplyTaskArgs,
  buildTaskManifest,
  collectOutputs,
  createTaskNameEntropy,
  extractIdentity,
  generateTaskName,
  getInput,
  getWaitPollIntervalSeconds,
  parseInteger,
  parseKeyValueLines,
  parseOptionalInteger,
  readIntegerInput,
  toInputEnvKey,
  waitForTask,
  shouldApplyWithNamespace
} = require("../dist/index.js");

test("generateTaskName appends GitHub run suffix", () => {
  assert.equal(generateTaskName("", "Repo Review Task", "123456", "7", "abc123"), "repo-review-task-123456-7-abc123");
});

test("generateTaskName rejects invalid explicit names", () => {
  assert.throws(() => generateTaskName("Not_Valid", "ignored", "1", "1"), UserError);
});

test("generateTaskName produces unique defaults for separate invocations", () => {
  assert.notEqual(
    generateTaskName("", "kelos-task", "123456", "1", "aaa111"),
    generateTaskName("", "kelos-task", "123456", "1", "bbb222")
  );
});

test("createTaskNameEntropy returns a lowercase hex suffix", () => {
  assert.match(createTaskNameEntropy(4), /^[a-f0-9]{8}$/);
});

test("parseKeyValueLines requires key=value format", () => {
  assert.throws(() => parseKeyValueLines("owner"), UserError);
});

test("toInputEnvKey preserves hyphens from action input names", () => {
  assert.equal(toInputEnvKey("credentials-secret"), "INPUT_CREDENTIALS-SECRET");
  assert.equal(getInput("credentials-secret", true, { "INPUT_CREDENTIALS-SECRET": "token" }), "token");
});

test("readIntegerInput rejects partial integers", () => {
  assert.throws(
    () => readIntegerInput("timeout-seconds", 1800, { "INPUT_TIMEOUT-SECONDS": "10s" }),
    UserError
  );
});

test("parseInteger rejects partial integers", () => {
  assert.throws(() => parseInteger("1h", "timeout-seconds"), UserError);
  assert.throws(() => parseOptionalInteger("3600s", "ttl-seconds-after-finished"), UserError);
});

test("getWaitPollIntervalSeconds reduces polling for short TTL values", () => {
  assert.equal(getWaitPollIntervalSeconds(10, { spec: { ttlSecondsAfterFinished: 4 } }), 2);
  assert.equal(getWaitPollIntervalSeconds(10, { spec: { ttlSecondsAfterFinished: 1 } }), 0.5);
  assert.equal(getWaitPollIntervalSeconds(10, { spec: { ttlSecondsAfterFinished: 0 } }), 10);
  assert.equal(getWaitPollIntervalSeconds(10, {}), 10);
});

test("buildTaskManifest includes optional Task fields", () => {
  const manifest = buildTaskManifest(
    {
      kubeconfig: "",
      namespace: "agents",
      taskFile: "",
      taskName: "review-123",
      taskNamePrefix: "kelos-task",
      type: "codex",
      prompt: "Review this repository.",
      credentialsSecret: "codex-token",
      credentialsType: "oauth",
      model: "gpt-5.4",
      image: "ghcr.io/example/agent:latest",
      workspace: "repo-workspace",
      agentConfig: "repo-config",
      branch: "review-branch",
      dependsOn: "build,lint",
      ttlSecondsAfterFinished: "3600",
      podOverridesJson: "{\"activeDeadlineSeconds\":600}",
      labels: "team=platform\npurpose=review",
      annotations: "owner=actions",
      wait: false,
      timeoutSeconds: 1800,
      pollIntervalSeconds: 10
    },
    {
      GITHUB_RUN_ID: "99",
      GITHUB_RUN_ATTEMPT: "2",
      GITHUB_REPOSITORY: "org/repo",
      GITHUB_WORKFLOW: "CI",
      GITHUB_SHA: "abc123",
      GITHUB_REF: "refs/heads/main",
      GITHUB_ACTOR: "octocat",
      GITHUB_SERVER_URL: "https://github.com",
      GITHUB_JOB: "deploy"
    }
  );

  assert.equal(manifest.metadata.name, "review-123");
  assert.equal(manifest.metadata.namespace, "agents");
  assert.equal(manifest.spec.type, "codex");
  assert.equal(manifest.spec.credentials.secretRef.name, "codex-token");
  assert.deepEqual(manifest.spec.dependsOn, ["build", "lint"]);
  assert.equal(manifest.spec.ttlSecondsAfterFinished, 3600);
  assert.equal(manifest.spec.workspaceRef.name, "repo-workspace");
  assert.equal(manifest.spec.agentConfigRef.name, "repo-config");
  assert.equal(manifest.spec.podOverrides.activeDeadlineSeconds, 600);
  assert.equal(manifest.metadata.labels.team, "platform");
  assert.equal(manifest.metadata.annotations["kelos.dev/github-run-url"], "https://github.com/org/repo/actions/runs/99");
});

test("extractIdentity requires a Kelos Task resource", () => {
  assert.throws(() => extractIdentity({ apiVersion: "v1", kind: "ConfigMap", metadata: {} }), UserError);
});

test("collectOutputs flattens Kelos results", () => {
  const outputs = collectOutputs(
    {
      status: {
        phase: "Succeeded",
        message: "completed",
        jobName: "task-job",
        podName: "task-pod",
        results: {
          branch: "feature/review",
          commit: "abc123",
          "base-branch": "main",
          pr: "https://github.com/org/repo/pull/10",
          "cost-usd": "0.42",
          "input-tokens": "100",
          "output-tokens": "200"
        }
      }
    },
    "review-1",
    "agents"
  );

  assert.equal(outputs.task_name, "review-1");
  assert.equal(outputs.task_namespace, "agents");
  assert.equal(outputs.phase, "Succeeded");
  assert.equal(outputs.job_name, "task-job");
  assert.equal(outputs.base_branch, "main");
  assert.equal(
    outputs.results_json,
    "{\"branch\":\"feature/review\",\"commit\":\"abc123\",\"base-branch\":\"main\",\"pr\":\"https://github.com/org/repo/pull/10\",\"cost-usd\":\"0.42\",\"input-tokens\":\"100\",\"output-tokens\":\"200\"}"
  );
});

test("collectOutputs preserves nested results in results_json", () => {
  const outputs = collectOutputs(
    {
      status: {
        results: {
          summary: {
            files: ["a.ts", "b.ts"],
            counts: {
              added: 2
            }
          }
        }
      }
    },
    "review-1",
    "agents"
  );

  assert.equal(outputs.results_json, "{\"summary\":{\"files\":[\"a.ts\",\"b.ts\"],\"counts\":{\"added\":2}}}");
});

test("shouldApplyWithNamespace returns false for explicit namespace mismatch", () => {
  const runner = () => {
    throw new CommandError(
      "the namespace from the provided object \"agents\" does not match the namespace \"default\". You must pass '--namespace=agents' to perform this operation."
    );
  };

  assert.equal(shouldApplyWithNamespace("task.yaml", "default", runner), false);
});

test("shouldApplyWithNamespace returns true when dry-run create succeeds", () => {
  const runner = () => "{}";
  assert.equal(shouldApplyWithNamespace("task.yaml", "default", runner), true);
});

test("buildApplyTaskArgs omits -n when namespace should come from the file", () => {
  assert.deepEqual(buildApplyTaskArgs("task.yaml", "default", false), ["apply", "-f", "task.yaml", "-o", "json"]);
  assert.deepEqual(buildApplyTaskArgs("task.yaml", "default", true), ["apply", "-n", "default", "-f", "task.yaml", "-o", "json"]);
});

test("waitForTask fails fast when an observed Task disappears", async () => {
  await assert.rejects(
    waitForTask(
      "review-1",
      "agents",
      60,
      10,
      {
        metadata: { name: "review-1", namespace: "agents" },
        status: { phase: "Running" }
      },
      () => {
        throw new CommandError("NotFound", "", "task not found");
      },
      async () => {}
    ),
    TaskDeletedError
  );
});
