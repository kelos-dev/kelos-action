# kelos-action

GitHub Action for creating a Kelos `Task` from workflow inputs or applying an
existing Task manifest.

The action can:

- apply a checked-in Task manifest with `kubectl`
- build a Task manifest from structured inputs
- optionally wait for the Task to finish and expose Kelos result fields as
  workflow outputs
- run as a JavaScript action with TypeScript source checked into `src/`

## Requirements

- a Kubernetes cluster with Kelos installed
- `kubectl` available in the workflow runner
- access to the cluster, either from the current runner context or via the
  `kubeconfig` input
- Node 20+ when developing the action locally

## Usage

Until the first tagged release is published, reference this action with
`@main`. Switch the examples to `@v1` after the release tag exists.

Apply an existing manifest:

```yaml
jobs:
  deploy-kelos-task:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: azure/setup-kubectl@v4
      - uses: kelos-dev/kelos-action@main
        with:
          kubeconfig: ${{ secrets.KUBECONFIG }}
          namespace: agents
          task-file: .github/kelos/review-task.yaml
```

Create a Task from workflow inputs and wait for completion:

```yaml
jobs:
  deploy-kelos-task:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: azure/setup-kubectl@v4
      - id: kelos
        uses: kelos-dev/kelos-action@main
        with:
          kubeconfig: ${{ secrets.KUBECONFIG }}
          namespace: agents
          type: codex
          prompt: |
            Review the latest changes in this repository and open a PR if fixes
            are needed.
          credentials-secret: codex-oauth-token
          credentials-type: oauth
          workspace: repo-workspace
          agent-config: repo-agent-config
          wait: "true"
      - run: echo "Task phase: ${{ steps.kelos.outputs.phase }}"
      - run: echo "PR: ${{ steps.kelos.outputs.pr }}"
```

## Inputs

| Input | Description | Required |
| --- | --- | --- |
| `kubeconfig` | Raw kubeconfig content. Leave empty to use the runner's current kubectl context. | No |
| `namespace` | Namespace for generated Tasks, or the default namespace used when applying `task-file`. | No |
| `task-file` | Path to an existing Kelos Task manifest. If set, structured Task inputs are ignored. | No |
| `task-name` | Explicit Task name for generated manifests. | No |
| `task-name-prefix` | Prefix used when auto-generating a Task name. | No |
| `type` | Kelos agent type for generated manifests. | Conditionally |
| `prompt` | Task prompt for generated manifests. | Conditionally |
| `credentials-secret` | Secret name for `spec.credentials.secretRef.name`. | Conditionally |
| `credentials-type` | Task credential type, `oauth` or `api-key`. | No |
| `model` | Optional `spec.model` value. | No |
| `image` | Optional `spec.image` override. | No |
| `workspace` | Optional `spec.workspaceRef.name`. | No |
| `agent-config` | Optional `spec.agentConfigRef.name`. | No |
| `branch` | Optional `spec.branch`. | No |
| `depends-on` | Newline or comma separated `spec.dependsOn` entries. | No |
| `ttl-seconds-after-finished` | Optional `spec.ttlSecondsAfterFinished`. | No |
| `pod-overrides-json` | JSON object assigned to `spec.podOverrides`. | No |
| `labels` | Newline-delimited metadata labels as `key=value`. | No |
| `annotations` | Newline-delimited metadata annotations as `key=value`. | No |
| `wait` | Wait for the Task to reach `Succeeded` or `Failed`. | No |
| `timeout-seconds` | Wait timeout when `wait` is enabled. | No |
| `poll-interval-seconds` | Poll interval when `wait` is enabled. | No |

Structured mode requires `type`, `prompt`, and `credentials-secret`.

`task-file` should point to a single Kelos `Task` resource.

## Outputs

| Output | Description |
| --- | --- |
| `task_name` | Created or updated Kelos Task name |
| `task_namespace` | Namespace containing the Task |
| `phase` | Current or final Kelos Task phase |
| `message` | Current or final Task status message |
| `job_name` | Backing Kubernetes Job name, when available |
| `pod_name` | Backing Kubernetes Pod name, when available |
| `branch` | Parsed Kelos result `branch` |
| `commit` | Parsed Kelos result `commit` |
| `base_branch` | Parsed Kelos result `base-branch` |
| `pr` | Parsed Kelos result `pr` |
| `cost_usd` | Parsed Kelos result `cost-usd` |
| `input_tokens` | Parsed Kelos result `input-tokens` |
| `output_tokens` | Parsed Kelos result `output-tokens` |
| `results_json` | Raw `status.results` JSON string |

If `wait: "true"` is set, the action fails when the Task finishes in `Failed` or
does not reach a terminal phase before the timeout.
