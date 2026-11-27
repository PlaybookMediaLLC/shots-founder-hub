"""Render Google Cloud Run manifests for the API and optionally sync Secret Manager.

Never print secret values to stdout or stderr.
"""

import argparse
import hashlib
import json
import subprocess
from pathlib import Path

from prepare_api_service_secrets import select

SERVICE_NAME = "founder-hub-api"
MIGRATE_JOB_NAME = "founder-hub-api-migrate"
PORT = 3001
SECRET_PREFIX = "founder-hub-api-"


def secret_id(env_key):
    return SECRET_PREFIX + env_key.lower().replace("_", "-")


def build_secret_plan(secrets):
    runtime_secrets = select("all", secrets)
    migration_url = next(
        (
            item.get("value")
            for item in secrets
            if item["key"] == "DATABASE_MIGRATION_URL"
        ),
        None,
    )
    if not migration_url:
        raise ValueError("Missing required service secrets: DATABASE_MIGRATION_URL")

    plan = {secret_id(key): value for key, value in sorted(runtime_secrets.items())}
    migration_secret_id = secret_id("DATABASE_MIGRATION_URL")
    plan[migration_secret_id] = migration_url
    return runtime_secrets, migration_secret_id, plan


def _gcloud(args, input_bytes=None, check=True):
    return subprocess.run(
        ["gcloud", *args],
        input=input_bytes,
        capture_output=True,
        check=check,
    )


def sync_secret_manager(secret_plan, project):
    """Idempotently sync secrets to GCP Secret Manager without logging values.

    Returns a mapping of secret_id -> active version string.
    """
    versions = {}
    for name, value in sorted(secret_plan.items()):
        payload = value.encode("utf-8")
        desired_sha = hashlib.sha256(payload).hexdigest()

        exists = _gcloud(
            [
                "secrets",
                "describe",
                name,
                f"--project={project}",
                "--format=value(name)",
            ],
            check=False,
        )
        if exists.returncode != 0:
            _gcloud(
                [
                    "secrets",
                    "create",
                    name,
                    f"--project={project}",
                    "--replication-policy=automatic",
                    "--labels=managed-by=api-cd,service=founder-hub-api",
                ]
            )

        current_version = None
        latest_meta = _gcloud(
            [
                "secrets",
                "versions",
                "describe",
                "latest",
                f"--secret={name}",
                f"--project={project}",
                "--format=value(name,state)",
            ],
            check=False,
        )
        if latest_meta.returncode == 0:
            parts = latest_meta.stdout.decode("utf-8").strip().split()
            if len(parts) >= 2 and parts[1] == "ENABLED":
                latest_id = parts[0].rsplit("/", 1)[-1]
                access = _gcloud(
                    [
                        "secrets",
                        "versions",
                        "access",
                        latest_id,
                        f"--secret={name}",
                        f"--project={project}",
                    ],
                    check=False,
                )
                if access.returncode == 0:
                    if hashlib.sha256(access.stdout).hexdigest() == desired_sha:
                        current_version = latest_id

        if current_version is None:
            added = _gcloud(
                [
                    "secrets",
                    "versions",
                    "add",
                    name,
                    f"--project={project}",
                    "--data-file=-",
                    "--format=value(name)",
                ],
                input_bytes=payload,
            )
            current_version = added.stdout.decode("utf-8").strip().rsplit("/", 1)[-1]

        versions[name] = current_version
    return versions


def render_manifests(
    image,
    secrets,
    region="us-west1",
    service_account="sa-api-runtime@shots-founder-hub-prod.iam.gserviceaccount.com",
    secret_versions=None,
):
    runtime_secrets, migration_secret_id, secret_plan = build_secret_plan(secrets)
    versions = secret_versions or {name: "latest" for name in secret_plan}

    runtime_env = [
        {"name": "ANARLOG_SERVICE", "value": "all"},
        {"name": "ANARLOG_ATTACHMENT_BACKUP_GC_ENABLED", "value": "true"},
    ]
    for key in sorted(runtime_secrets):
        sid = secret_id(key)
        runtime_env.append(
            {
                "name": key,
                "valueFrom": {
                    "secretKeyRef": {
                        "name": sid,
                        "key": str(versions[sid]),
                    }
                },
            }
        )

    service_manifest = {
        "apiVersion": "serving.knative.dev/v1",
        "kind": "Service",
        "metadata": {
            "name": SERVICE_NAME,
            "labels": {
                "cloud.googleapis.com/location": region,
            },
            "annotations": {
                "run.googleapis.com/ingress": "all",
                "run.googleapis.com/launch-stage": "GA",
            },
        },
        "spec": {
            "template": {
                "metadata": {
                    "annotations": {
                        "autoscaling.knative.dev/minScale": "1",
                        "autoscaling.knative.dev/maxScale": "10",
                        "run.googleapis.com/execution-environment": "gen2",
                        "run.googleapis.com/cpu-throttling": "false",
                        "run.googleapis.com/startup-cpu-boost": "true",
                        "run.googleapis.com/sessionAffinity": "true",
                    }
                },
                "spec": {
                    "containerConcurrency": 80,
                    "timeoutSeconds": 3600,
                    "serviceAccountName": service_account,
                    "containers": [
                        {
                            "name": SERVICE_NAME,
                            "image": image,
                            "ports": [{"name": "http1", "containerPort": PORT}],
                            "resources": {
                                "limits": {
                                    "cpu": "2",
                                    "memory": "2Gi",
                                }
                            },
                            "startupProbe": {
                                "httpGet": {"path": "/health", "port": PORT},
                                "initialDelaySeconds": 5,
                                "periodSeconds": 5,
                                "timeoutSeconds": 3,
                                "failureThreshold": 12,
                            },
                            "livenessProbe": {
                                "httpGet": {"path": "/health", "port": PORT},
                                "periodSeconds": 15,
                                "timeoutSeconds": 3,
                                "failureThreshold": 3,
                            },
                            "env": runtime_env,
                        }
                    ],
                },
            },
            "traffic": [{"percent": 100, "latestRevision": True}],
        },
    }

    migrate_manifest = {
        "apiVersion": "run.googleapis.com/v1",
        "kind": "Job",
        "metadata": {
            "name": MIGRATE_JOB_NAME,
            "labels": {
                "cloud.googleapis.com/location": region,
            },
            "annotations": {
                "run.googleapis.com/launch-stage": "GA",
            },
        },
        "spec": {
            "template": {
                "spec": {
                    "taskCount": 1,
                    "template": {
                        "spec": {
                            "maxRetries": 1,
                            "timeoutSeconds": 600,
                            "serviceAccountName": service_account,
                            "containers": [
                                {
                                    "name": MIGRATE_JOB_NAME,
                                    "image": image,
                                    "command": ["/usr/local/bin/migrate"],
                                    "resources": {
                                        "limits": {
                                            "cpu": "1",
                                            "memory": "512Mi",
                                        }
                                    },
                                    "env": [
                                        {
                                            "name": "DATABASE_URL",
                                            "valueFrom": {
                                                "secretKeyRef": {
                                                    "name": migration_secret_id,
                                                    "key": str(
                                                        versions[migration_secret_id]
                                                    ),
                                                }
                                            },
                                        }
                                    ],
                                }
                            ],
                        }
                    },
                }
            }
        },
    }

    return migrate_manifest, service_manifest, secret_plan


def _write_secure_json(path, data):
    target = Path(path)
    target.touch(mode=0o600)
    target.chmod(0o600)
    target.write_text(json.dumps(data, indent=2) + "\n")


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--secrets", required=True, help="Infisical export (JSON)")
    parser.add_argument("--image", required=True, help="Full Artifact Registry image")
    parser.add_argument("--project", required=True, help="GCP project ID")
    parser.add_argument("--region", default="us-west1", help="Cloud Run region")
    parser.add_argument(
        "--service-account",
        required=True,
        help="Cloud Run runtime service account email",
    )
    parser.add_argument("--migrate-output", required=True)
    parser.add_argument("--service-output", required=True)
    parser.add_argument("--sync-secret-manager", action="store_true")
    args = parser.parse_args()

    secrets = json.loads(Path(args.secrets).read_text())
    _, _, secret_plan = build_secret_plan(secrets)
    versions = None
    if args.sync_secret_manager:
        versions = sync_secret_manager(secret_plan, args.project)

    migrate_manifest, service_manifest, _ = render_manifests(
        image=args.image,
        secrets=secrets,
        region=args.region,
        service_account=args.service_account,
        secret_versions=versions,
    )
    _write_secure_json(args.migrate_output, migrate_manifest)
    _write_secure_json(args.service_output, service_manifest)
    print(
        f"Rendered Cloud Run manifests for {SERVICE_NAME} "
        f"with {len(secret_plan)} Secret Manager references"
    )


if __name__ == "__main__":
    main()
