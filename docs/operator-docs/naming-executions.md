---
id: naming-executions
title: Naming Executinons
hide_title: false
---

By default, Cumulus will assign a random name to workflow executions. If
desired, though, a configurable prefix can be added to those execution names.

## Naming executions triggered by rules

Rules now have an optional `executionNamePrefix`. If set, any workflows
triggered directly by that rule will have an execution name that starts with
that prefix.

## Naming executions enqueued by the QueueGranules and QueuePdrs tasks

The `QueueGranules` and `QueuePdrs` tasks add executions to a queue to be run
later. These two tasks now support an optional config property called
`executionNamePrefix`. If specified, any executions enqueued by those tasks will
have an execution name that begins with that prefix. The value of that prefix
should be configured in the workflow that contains the `QueueGranules` or
`QueuePdrs` step.

In the following excerpt, the `QueueGranules` `config.executionNamePrefix`
property is set using the value configured in the workflow's
`meta.executionNamePrefix`.

**Example**

If you wanted to use a prefix of "my-prefix", you would create a rule with meta
similar to this:

```json
{
  "executionNamePrefix": "my-prefix"
}
```

The workflow could contain a "QueueGranules" step with the following state:

```json
{
  "QueueGranules": {
    "Parameters": {
      "cma": {
        "event.$": "$",
        "ReplaceConfig": {
          "FullMessage": true
        },
        "task_config": {
          "queueUrl": "${start_sf_queue_url}",
          "provider": "{$.meta.provider}",
          "internalBucket": "{$.meta.buckets.internal.name}",
          "stackName": "{$.meta.stack}",
          "granuleIngestWorkflow": "${ingest_granule_workflow_name}",
          "executionNamePrefix": "{$.meta.executionNamePrefix}"
        }
      }
    },
    "Type": "Task",
    "Resource": "${queue_granules_task_arn}",
    "Retry": [
      {
        "ErrorEquals": [
          "Lambda.ServiceException",
          "Lambda.AWSLambdaException",
          "Lambda.SdkClientException"
        ],
        "IntervalSeconds": 2,
        "MaxAttempts": 6,
        "BackoffRate": 2
      }
    ],
    "Catch": [
      {
        "ErrorEquals": [
          "States.ALL"
        ],
        "ResultPath": "$.exception",
        "Next": "WorkflowFailed"
      }
    ],
    "End": true
  },
}
```