"""Chapter 13: the restocking agent, started every Monday at 7 a.m. by Managed Agents (beta).

By default, this script does not call the API: it shows the request it would send. With --create,
it creates a scheduled deployment, which will start a session every Monday, with its budget, until
you archive it (python -m ch13.schedule_monday --archive ID). Each session costs money.

Warning: the chapter's agent has custom tools, run by your code. A scheduled session that
calls such a tool goes into waiting (requires_action) as long as nobody answers. A schedule
therefore requires a program that listens to the events (webhooks), or tools that run on
Anthropic's side: an MCP server (chapters 14 to 16).

Run, from the python/ folder:
    python -m ch13.schedule_monday --agent AGENT_ID --environment ENV_ID             (shows only)
    python -m ch13.schedule_monday --agent AGENT_ID --environment ENV_ID --create    (creates the deployment)
"""

import argparse
import json

import anthropic

from comptoir.restock_agent import INSTRUCTION

MONDAY_7AM = {"type": "cron", "expression": "0 7 * * 1", "timezone": "Africa/Porto-Novo"}


def request(agent: str, environment: str, budget_cents: int) -> dict:
    return {
        "name": "Monday restocking",
        "agent": agent,
        "environment_id": environment,
        "initial_events": [{"type": "user.message", "content": [{"type": "text", "text": INSTRUCTION}]}],
        "schedule": MONDAY_7AM,
        # Copied onto each session started: it caps each Monday, not the total.
        "budget": {"type": "limit", "max_list_cost": {"amount": str(budget_cents), "currency": "USD"}},
    }


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--agent")
    parser.add_argument("--environment")
    parser.add_argument("--budget-cents", type=int, default=50)
    parser.add_argument("--create", action="store_true", help="really creates the deployment (paid every Monday)")
    parser.add_argument("--archive", metavar="DEPLOYMENT_ID", help="archives a deployment: no more starts")
    args = parser.parse_args()

    if args.archive:
        anthropic.Anthropic().beta.deployments.archive(args.archive)
        print(f"Deployment {args.archive} archived: it will start nothing any more.")
        return
    if not (args.agent and args.environment):
        parser.error("--agent and --environment are required")
    body = request(args.agent, args.environment, args.budget_cents)
    if not args.create:
        print("Request that would be sent (nothing is created without --create):")
        print(json.dumps(body, ensure_ascii=False, indent=2))
        return
    deployment = anthropic.Anthropic().beta.deployments.create(**body)
    print(f"Deployment {deployment.id} created; next starts: {deployment.schedule.upcoming_runs_at}")
    print(f"To stop it: python -m ch13.schedule_monday --archive {deployment.id}")


if __name__ == "__main__":
    main()
