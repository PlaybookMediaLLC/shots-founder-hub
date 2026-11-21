"""Render the DigitalOcean App Platform spec for the API; never print values.

One app runs the ai, sync, and core roles as internal services. A public
gateway runs the combined binary and forwards each role's routes to them.
"""

import argparse
import json
from pathlib import Path

from prepare_api_service_secrets import select

APP_NAME = "founder-hub-api"
DOMAIN = "founder-hub-api.shots.playbookmedia.io"
PORT = 3001
ROLES = {
    "ai": "apps-s-1vcpu-1gb",
    "sync": "apps-s-1vcpu-1gb",
    "core": "apps-s-1vcpu-1gb",
}
GATEWAY_SIZE = "apps-s-1vcpu-2gb"


def service(name, tag, size, plain, secrets):
    envs = [
        {"key": key, "value": value, "scope": "RUN_TIME"}
        for key, value in plain.items()
    ]
    envs += [
        {"key": key, "value": value, "scope": "RUN_TIME", "type": "SECRET"}
        for key, value in sorted(secrets.items())
    ]
    return {
        "name": name,
        "image": {
            "registry_type": "GHCR",
            "registry": "playbookmediallc",
            "repository": "shots-founder-hub-api",
            "tag": tag,
        },
        "instance_size_slug": size,
        "instance_count": 1,
        # Readiness also needs optional integrations, so it is not a deploy gate.
        "health_check": {
            "http_path": "/health",
            "port": PORT,
            "initial_delay_seconds": 20,
            "period_seconds": 15,
            "failure_threshold": 6,
        },
        # The API drains live streams for up to 270 s after SIGTERM
        # (TERM_DRAIN_TIMEOUT in apps/api/src/main.rs). Give it that time.
        "termination": {"grace_period_seconds": 300},
        "envs": envs,
    }


def render(tag, secrets):
    services = []
    for role, size in ROLES.items():
        item = service(
            role,
            tag,
            size,
            {
                "ANARLOG_SERVICE": role,
                "PORT": str(PORT),
                # One instance owns attachment-backup cleanup.
                "ANARLOG_ATTACHMENT_BACKUP_GC_ENABLED": str(role == "core").lower(),
            },
            select(role, secrets),
        )
        item["internal_ports"] = [PORT]
        services.append(item)
    gateway = service(
        "gateway",
        tag,
        GATEWAY_SIZE,
        {
            "ANARLOG_SERVICE": "all",
            "PORT": str(PORT),
            "ANARLOG_ATTACHMENT_BACKUP_GC_ENABLED": "false",
            # App Platform reaches each internal service by its component name.
            **{
                f"ANARLOG_{role.upper()}_ORIGIN": f"http://{role}:{PORT}"
                for role in ROLES
            },
        },
        select("gateway", secrets),
    )
    gateway["http_port"] = PORT
    services.insert(0, gateway)
    migration = next(
        (
            item.get("value")
            for item in secrets
            if item["key"] == "DATABASE_MIGRATION_URL"
        ),
        None,
    )
    if not migration:
        raise ValueError("Missing required service secrets: DATABASE_MIGRATION_URL")
    # Migrations run before each deploy, with the migration role.
    migrate = service(
        "migrate", tag, "apps-s-1vcpu-0.5gb", {}, {"DATABASE_URL": migration}
    )
    del migrate["health_check"], migrate["instance_count"]
    migrate["kind"] = "PRE_DEPLOY"
    migrate["run_command"] = "/usr/local/bin/migrate"
    return {
        "name": APP_NAME,
        "region": "nyc",
        "domains": [{"domain": DOMAIN, "type": "PRIMARY"}],
        "services": services,
        "jobs": [migrate],
        "ingress": {
            "rules": [
                {"match": {"path": {"prefix": "/"}}, "component": {"name": "gateway"}}
            ]
        },
    }


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--secrets", required=True, help="Infisical export (JSON)")
    parser.add_argument("--tag", required=True)
    parser.add_argument("--output", required=True)
    args = parser.parse_args()
    spec = render(args.tag, json.loads(Path(args.secrets).read_text()))
    path = Path(args.output)
    path.touch(mode=0o600)
    path.chmod(0o600)
    path.write_text(json.dumps(spec))
    print(f"Rendered {APP_NAME} with {len(spec['services'])} services")


if __name__ == "__main__":
    main()
