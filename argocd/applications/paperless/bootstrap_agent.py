"""Provision the dedicated Paperless API identity without emitting credentials."""

import json
import os
import re
import sys
from pathlib import Path

USERNAME = "agents-shell"
EMAIL = "agents-shell@paperless.local"
GROUP = "Agent Shell"
WORKFLOW = "Agent Shell document access"
PERMISSIONS = {
    "view_document",
    "add_document",
    "change_document",
    "view_paperlesstask",
    "view_tag",
    "add_tag",
    "view_correspondent",
    "add_correspondent",
    "view_documenttype",
    "add_documenttype",
    "view_storagepath",
    "view_customfield",
}


def main() -> None:
    token = Path(os.environ["PAPERLESS_AGENT_TOKEN_FILE"]).read_text().strip()
    if not re.fullmatch(r"[A-Za-z0-9]{40}", token):
        raise ValueError("Paperless API token must contain 40 alphanumeric characters")

    sys.path.insert(0, "/usr/src/paperless/src")
    os.environ.setdefault("DJANGO_SETTINGS_MODULE", "paperless.settings")
    import django

    django.setup()

    from django.contrib.auth import get_user_model
    from django.contrib.auth.models import Group, Permission
    from django.db import transaction
    from documents.models import Workflow, WorkflowAction, WorkflowTrigger
    from rest_framework.authtoken.models import Token

    with transaction.atomic():
        user, user_created = get_user_model().objects.get_or_create(
            username=USERNAME,
            defaults={"email": EMAIL, "is_staff": False, "is_superuser": False},
        )
        if (
            user.is_staff
            or user.is_superuser
            or user.email != EMAIL
            or not user.is_active
        ):
            raise RuntimeError(
                "Existing agents-shell account is not the managed API identity"
            )
        if user_created:
            user.set_unusable_password()
            user.save(update_fields=["password"])
        elif user.has_usable_password():
            raise RuntimeError("Managed API identity unexpectedly has a login password")

        group, _ = Group.objects.get_or_create(name=GROUP)
        if group.user_set.exclude(pk=user.pk).exists():
            raise RuntimeError("Managed API group contains an unexpected user")
        if user.groups.exclude(pk=group.pk).exists() or user.user_permissions.exists():
            raise RuntimeError(
                "Managed API identity has unexpected additional privileges"
            )
        permissions = Permission.objects.filter(
            content_type__app_label="documents", codename__in=PERMISSIONS
        )
        if set(permissions.values_list("codename", flat=True)) != PERMISSIONS:
            raise RuntimeError("Paperless permission contract changed")
        group.permissions.set(permissions)
        user.groups.add(group)

        if Token.objects.filter(key=token).exclude(user=user).exists():
            raise RuntimeError("Managed API token belongs to another identity")
        existing_token, _ = Token.objects.get_or_create(
            user=user, defaults={"key": token}
        )
        if existing_token.key != token:
            Token.objects.filter(user=user).update(key=token)

        workflow, workflow_created = Workflow.objects.get_or_create(
            name=WORKFLOW, defaults={"order": 100, "enabled": True}
        )
        if workflow_created:
            trigger = WorkflowTrigger.objects.create(
                type=WorkflowTrigger.WorkflowTriggerType.DOCUMENT_ADDED,
                matching_algorithm=WorkflowTrigger.WorkflowTriggerMatching.NONE,
            )
            action = WorkflowAction.objects.create(
                type=WorkflowAction.WorkflowActionType.ASSIGNMENT, order=0
            )
            workflow.triggers.add(trigger)
            workflow.actions.add(action)
        else:
            trigger = workflow.triggers.get()
            action = workflow.actions.get()
            if (
                not workflow.enabled
                or trigger.type != WorkflowTrigger.WorkflowTriggerType.DOCUMENT_ADDED
                or trigger.matching_algorithm
                != WorkflowTrigger.WorkflowTriggerMatching.NONE
                or action.type != WorkflowAction.WorkflowActionType.ASSIGNMENT
            ):
                raise RuntimeError(
                    "Managed document access workflow was changed; review it before syncing"
                )
        # Assignment merges these grants while retaining owners and existing permissions.
        action.assign_view_groups.add(group)
        action.assign_change_groups.add(group)

    print(
        json.dumps(
            {
                "username": USERNAME,
                "user_created": user_created,
                "workflow_created": workflow_created,
                "permissions": sorted(PERMISSIONS),
                "token_configured": True,
            }
        )
    )


if __name__ == "__main__":
    main()
