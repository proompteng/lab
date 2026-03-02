#!/usr/bin/env python3
"""Huly API helper for swarm agents.

Supports two modes:
- `--operation http`: raw authenticated HTTP call (backward compatible)
- higher-level Huly operations for issues, channels, and documents via transactor API
"""

from __future__ import annotations

import argparse
import base64
import json
import os
import secrets
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from dataclasses import dataclass
from typing import Any

ISSUE_CLASS = 'tracker:class:Issue'
PROJECT_CLASS = 'tracker:class:Project'
TEAMSPACE_CLASS = 'document:class:Teamspace'
DOCUMENT_CLASS = 'document:class:Document'
CHANNEL_CLASS = 'chunter:class:Channel'
CHAT_MESSAGE_CLASS = 'chunter:class:ChatMessage'

TX_CREATE_CLASS = 'core:class:TxCreateDoc'
TX_UPDATE_CLASS = 'core:class:TxUpdateDoc'
TX_SPACE = 'core:space:Tx'

DEFAULT_ISSUE_STATUS = 'tracker:status:Backlog'
DEFAULT_ISSUE_KIND = 'tracker:taskTypes:Issue'
DEFAULT_DOCUMENT_PARENT = 'document:ids:NoParent'
DEFAULT_RANK = '0|zzzzzz:'
DEFAULT_TEAMSPACE = 'PROOMPTENG'


@dataclass
class HulyContext:
    base_url: str
    token: str
    token_source: str
    workspace_id: str
    actor_id: str
    timeout_seconds: int


def env_first(*keys: str) -> str:
    for key in keys:
        value = os.getenv(key, '').strip()
        if value:
            return value
    return ''


def env_if_set(key: str) -> str:
    return os.getenv(key, '').strip()


def normalize_token_key(value: str) -> str:
    parts: list[str] = []
    for char in value.strip():
        if char.isalnum():
            parts.append(char.upper())
        else:
            parts.append('_')
    normalized = ''.join(parts).strip('_')
    while '__' in normalized:
        normalized = normalized.replace('__', '_')
    return normalized


def resolve_token(args: argparse.Namespace) -> tuple[str, str]:
    explicit = args.token.strip()
    if explicit:
        return explicit, 'cli'

    token_env_key = args.token_env_key.strip()
    if token_env_key:
        candidate = env_if_set(token_env_key)
        if candidate:
            return candidate, token_env_key

    worker_identity = args.worker_identity.strip() or env_if_set('SWARM_AGENT_IDENTITY')
    if worker_identity:
        key = f'HULY_API_TOKEN_{normalize_token_key(worker_identity)}'
        candidate = env_if_set(key)
        if candidate:
            return candidate, key

    worker_id = args.worker_id.strip() or env_if_set('SWARM_AGENT_WORKER_ID')
    if worker_id:
        key = f'HULY_API_TOKEN_{normalize_token_key(worker_id)}'
        candidate = env_if_set(key)
        if candidate:
            return candidate, key

    if args.require_worker_token:
        return '', ''

    fallback = env_first('HULY_API_TOKEN', 'HULY_TOKEN')
    if fallback:
        return fallback, 'HULY_API_TOKEN/HULY_TOKEN'
    return '', ''


def maybe_parse_json(value: str) -> Any:
    try:
        return json.loads(value)
    except json.JSONDecodeError:
        return value


def parse_headers(raw_headers: list[str]) -> dict[str, str]:
    headers: dict[str, str] = {}
    for header in raw_headers:
        if ':' not in header:
            raise ValueError(f'invalid header format (expected key:value): {header}')
        key, value = header.split(':', 1)
        headers[key.strip()] = value.strip()
    return headers


def join_url(base_url: str, path: str) -> str:
    normalized_base = base_url.rstrip('/')
    normalized_path = path if path.startswith('/') else f'/{path}'
    return f'{normalized_base}{normalized_path}'


def decode_jwt_payload(token: str) -> dict[str, Any]:
    parts = token.split('.')
    if len(parts) < 2:
        return {}
    payload = parts[1]
    payload += '=' * ((4 - len(payload) % 4) % 4)
    try:
        decoded = base64.urlsafe_b64decode(payload.encode('utf-8')).decode('utf-8')
        data = json.loads(decoded)
        if isinstance(data, dict):
            return data
    except (ValueError, json.JSONDecodeError):
        return {}
    return {}


def normalize_api_base_url(base_url: str) -> str:
    """Normalize API base URL for transactor-backed REST API.

    Frontend service URLs do not expose `/api/v1/*` endpoints directly in-cluster.
    Convert `front.<domain>` to `transactor.<domain>` when possible.
    """

    raw = base_url.strip().rstrip('/')
    if not raw:
        return ''

    parsed = urllib.parse.urlparse(raw)
    if not parsed.scheme or not parsed.netloc:
        return raw

    hostname = parsed.hostname or ''
    port = f':{parsed.port}' if parsed.port else ''
    target_hostname = hostname

    if hostname.lower().startswith('front.'):
        target_hostname = f"transactor.{hostname[len('front.'):]}"

    return f'{parsed.scheme}://{target_hostname}{port}'


def api_call(
    *,
    method: str,
    url: str,
    token: str,
    timeout_seconds: int,
    data: Any | None = None,
    extra_headers: dict[str, str] | None = None,
) -> Any:
    headers = {
        'Accept': 'application/json',
        'Authorization': f'Bearer {token}',
    }
    if extra_headers:
        headers.update(extra_headers)

    body = None
    if data is not None:
        body = json.dumps(data).encode('utf-8')
        headers.setdefault('Content-Type', 'application/json')

    request = urllib.request.Request(url=url, method=method.upper(), headers=headers, data=body)

    try:
        with urllib.request.urlopen(request, timeout=timeout_seconds) as response:
            raw_body = response.read().decode('utf-8', errors='replace')
            content_type = response.headers.get('Content-Type', '')
            if 'json' in content_type.lower():
                return maybe_parse_json(raw_body)
            return raw_body
    except urllib.error.HTTPError as error:
        error_body = error.read().decode('utf-8', errors='replace')
        details = {
            'status': error.code,
            'reason': error.reason,
            'url': url,
            'body': maybe_parse_json(error_body),
        }
        raise RuntimeError(json.dumps(details, sort_keys=True)) from error
    except urllib.error.URLError as error:
        raise RuntimeError(f'request failed: {error.reason}') from error


def find_all(
    *,
    context: HulyContext,
    class_name: str,
    query: dict[str, Any],
    options: dict[str, Any] | None = None,
) -> list[dict[str, Any]]:
    payload: dict[str, Any] = {
        '_class': class_name,
        'query': query,
    }
    if options:
        payload['options'] = options

    raw = api_call(
        method='POST',
        url=join_url(context.base_url, f'/api/v1/find-all/{context.workspace_id}'),
        token=context.token,
        timeout_seconds=context.timeout_seconds,
        data=payload,
    )

    if isinstance(raw, dict) and isinstance(raw.get('value'), list):
        value = raw['value']
        return [item for item in value if isinstance(item, dict)]
    if isinstance(raw, list):
        return [item for item in raw if isinstance(item, dict)]
    return []


def submit_tx(*, context: HulyContext, payload: dict[str, Any]) -> Any:
    return api_call(
        method='POST',
        url=join_url(context.base_url, f'/api/v1/tx/{context.workspace_id}'),
        token=context.token,
        timeout_seconds=context.timeout_seconds,
        data=payload,
    )


def now_ms() -> int:
    return int(time.time() * 1000)


def new_id() -> str:
    return secrets.token_hex(12)


def create_tx_create_doc(
    *,
    actor_id: str,
    object_class: str,
    object_space: str,
    attributes: dict[str, Any],
    object_id: str | None = None,
    attached_to: str | None = None,
    attached_to_class: str | None = None,
    collection: str | None = None,
) -> dict[str, Any]:
    tx: dict[str, Any] = {
        '_id': new_id(),
        '_class': TX_CREATE_CLASS,
        'space': TX_SPACE,
        'objectId': object_id or new_id(),
        'objectClass': object_class,
        'objectSpace': object_space,
        'modifiedOn': now_ms(),
        'modifiedBy': actor_id,
        'createdBy': actor_id,
        'attributes': attributes,
    }
    if attached_to:
        tx['attachedTo'] = attached_to
    if attached_to_class:
        tx['attachedToClass'] = attached_to_class
    if collection:
        tx['collection'] = collection
    return tx


def create_tx_update_doc(
    *,
    actor_id: str,
    object_class: str,
    object_space: str,
    object_id: str,
    operations: dict[str, Any],
) -> dict[str, Any]:
    return {
        '_id': new_id(),
        '_class': TX_UPDATE_CLASS,
        'space': TX_SPACE,
        'objectId': object_id,
        'objectClass': object_class,
        'objectSpace': object_space,
        'modifiedOn': now_ms(),
        'modifiedBy': actor_id,
        'operations': operations,
    }


def resolve_project(context: HulyContext, project_ref: str) -> dict[str, Any]:
    project_ref = project_ref.strip()
    if project_ref:
        for query in ({'_id': project_ref}, {'identifier': project_ref}, {'name': project_ref}):
            projects = find_all(context=context, class_name=PROJECT_CLASS, query=query, options={'limit': 1})
            if projects:
                return projects[0]

    projects = find_all(
        context=context,
        class_name=PROJECT_CLASS,
        query={'archived': False},
        options={'limit': 1, 'sort': {'modifiedOn': -1}},
    )
    if not projects:
        raise RuntimeError('no tracker project found in workspace')
    return projects[0]


def resolve_teamspace(context: HulyContext, teamspace_ref: str) -> dict[str, Any]:
    teamspace_ref = teamspace_ref.strip()
    if teamspace_ref:
        for query in ({'_id': teamspace_ref}, {'name': teamspace_ref}):
            spaces = find_all(context=context, class_name=TEAMSPACE_CLASS, query=query, options={'limit': 1})
            if spaces:
                return spaces[0]

    spaces = find_all(
        context=context,
        class_name=TEAMSPACE_CLASS,
        query={'archived': False},
        options={'limit': 1, 'sort': {'modifiedOn': -1}},
    )
    if not spaces:
        raise RuntimeError('no document teamspace found in workspace')
    return spaces[0]


def resolve_channel(context: HulyContext, channel_ref: str) -> dict[str, Any]:
    channel_ref = channel_ref.strip()
    if channel_ref:
        for query in ({'_id': channel_ref}, {'name': channel_ref}):
            channels = find_all(context=context, class_name=CHANNEL_CLASS, query=query, options={'limit': 1})
            if channels:
                return channels[0]

    channels = find_all(
        context=context,
        class_name=CHANNEL_CLASS,
        query={'archived': False},
        options={'limit': 1, 'sort': {'modifiedOn': -1}},
    )
    if not channels:
        raise RuntimeError('no chat channel found in workspace')
    return channels[0]


def latest_issue_number(context: HulyContext, project_id: str) -> int:
    issues = find_all(
        context=context,
        class_name=ISSUE_CLASS,
        query={'space': project_id},
        options={'limit': 1, 'sort': {'number': -1}},
    )
    if not issues:
        return 0
    current = issues[0].get('number')
    if isinstance(current, int):
        return current
    if isinstance(current, float):
        return int(current)
    return 0


def find_issue_by_title(context: HulyContext, project_id: str, title: str) -> dict[str, Any] | None:
    issues = find_all(
        context=context,
        class_name=ISSUE_CLASS,
        query={'space': project_id, 'title': title},
        options={'limit': 1},
    )
    if issues:
        return issues[0]
    return None


def find_document_by_title(context: HulyContext, teamspace_id: str, title: str) -> dict[str, Any] | None:
    docs = find_all(
        context=context,
        class_name=DOCUMENT_CLASS,
        query={'space': teamspace_id, 'title': title},
        options={'limit': 1},
    )
    if docs:
        return docs[0]
    return None


def create_or_update_issue(
    *,
    context: HulyContext,
    project_ref: str,
    title: str,
    body: str,
    mission_id: str,
    status: str,
    priority: int,
) -> dict[str, Any]:
    project = resolve_project(context, project_ref)
    project_id = str(project.get('_id') or '')
    project_identifier = str(project.get('identifier') or '').strip()
    if not project_id:
        raise RuntimeError('resolved project is missing _id')

    mission_title = f'[mission:{mission_id}] {title}' if mission_id else title
    existing = find_issue_by_title(context, project_id, mission_title)
    if existing:
        issue_id = str(existing.get('_id') or '')
        if not issue_id:
            raise RuntimeError('resolved issue is missing _id')
        operations: dict[str, Any] = {
            'status': status,
            'priority': priority,
            'title': mission_title,
        }
        if body:
            operations['description'] = body
        tx = create_tx_update_doc(
            actor_id=context.actor_id,
            object_class=ISSUE_CLASS,
            object_space=project_id,
            object_id=issue_id,
            operations=operations,
        )
        submit_tx(context=context, payload=tx)
        return {
            'action': 'updated',
            'projectId': project_id,
            'issueId': issue_id,
            'issueTitle': mission_title,
            'projectIdentifier': project_identifier,
        }

    next_number = latest_issue_number(context, project_id) + 1
    identifier = f'{project_identifier}-{next_number}' if project_identifier else None

    attributes: dict[str, Any] = {
        'title': mission_title,
        'status': status,
        'number': next_number,
        'kind': DEFAULT_ISSUE_KIND,
        'priority': int(priority),
        'comments': 0,
        'subIssues': 0,
        'reports': 0,
        'estimation': 0,
        'remainingTime': 0,
        'reportedTime': 0,
        'parents': [],
        'childInfo': [],
        'dueDate': None,
        'assignee': None,
        'component': None,
        'rank': DEFAULT_RANK,
        'attachedTo': 'tracker:ids:NoParent',
        'attachedToClass': ISSUE_CLASS,
        'collection': 'subIssues',
    }
    if identifier:
        attributes['identifier'] = identifier
    if body:
        attributes['description'] = body

    issue_id = new_id()
    tx = create_tx_create_doc(
        actor_id=context.actor_id,
        object_class=ISSUE_CLASS,
        object_space=project_id,
        object_id=issue_id,
        attached_to=project_id,
        attached_to_class=PROJECT_CLASS,
        collection='issues',
        attributes=attributes,
    )
    submit_tx(context=context, payload=tx)

    return {
        'action': 'created',
        'projectId': project_id,
        'issueId': issue_id,
        'issueTitle': mission_title,
        'projectIdentifier': project_identifier,
        'issueNumber': next_number,
        'issueIdentifier': identifier,
    }


def create_or_update_document(
    *,
    context: HulyContext,
    teamspace_ref: str,
    title: str,
    body: str,
    mission_id: str,
) -> dict[str, Any]:
    teamspace = resolve_teamspace(context, teamspace_ref)
    teamspace_id = str(teamspace.get('_id') or '')
    if not teamspace_id:
        raise RuntimeError('resolved teamspace is missing _id')

    mission_title = f'[mission:{mission_id}] {title}' if mission_id else title
    existing = find_document_by_title(context, teamspace_id, mission_title)
    if existing:
        doc_id = str(existing.get('_id') or '')
        if not doc_id:
            raise RuntimeError('resolved document is missing _id')
        operations: dict[str, Any] = {'title': mission_title}
        if body:
            operations['content'] = body
        tx = create_tx_update_doc(
            actor_id=context.actor_id,
            object_class=DOCUMENT_CLASS,
            object_space=teamspace_id,
            object_id=doc_id,
            operations=operations,
        )
        submit_tx(context=context, payload=tx)
        return {
            'action': 'updated',
            'teamspaceId': teamspace_id,
            'documentId': doc_id,
            'documentTitle': mission_title,
        }

    attributes: dict[str, Any] = {
        'title': mission_title,
        'parent': DEFAULT_DOCUMENT_PARENT,
        'rank': DEFAULT_RANK,
    }
    if body:
        attributes['content'] = body

    doc_id = new_id()
    tx = create_tx_create_doc(
        actor_id=context.actor_id,
        object_class=DOCUMENT_CLASS,
        object_space=teamspace_id,
        object_id=doc_id,
        attributes=attributes,
    )
    submit_tx(context=context, payload=tx)

    return {
        'action': 'created',
        'teamspaceId': teamspace_id,
        'documentId': doc_id,
        'documentTitle': mission_title,
    }


def post_channel_message(
    *,
    context: HulyContext,
    channel_ref: str,
    message: str,
) -> dict[str, Any]:
    channel = resolve_channel(context, channel_ref)
    channel_id = str(channel.get('_id') or '')
    channel_name = str(channel.get('name') or '')
    if not channel_id:
        raise RuntimeError('resolved channel is missing _id')

    message_id = new_id()
    attributes = {
        'message': message,
        'attachments': 0,
    }
    tx = create_tx_create_doc(
        actor_id=context.actor_id,
        object_class=CHAT_MESSAGE_CLASS,
        object_space=channel_id,
        object_id=message_id,
        attached_to=channel_id,
        attached_to_class=CHANNEL_CLASS,
        collection='messages',
        attributes=attributes,
    )
    submit_tx(context=context, payload=tx)

    return {
        'action': 'created',
        'channelId': channel_id,
        'channelName': channel_name,
        'messageId': message_id,
    }


def build_context(args: argparse.Namespace, *, for_platform_api: bool) -> HulyContext:
    base_url_raw = args.base_url.strip() or env_first('HULY_API_BASE_URL', 'HULY_BASE_URL')
    if not base_url_raw:
        raise RuntimeError('missing HULY_API_BASE_URL/HULY_BASE_URL')

    token, token_source = resolve_token(args)
    if not token:
        if args.require_worker_token:
            raise RuntimeError('missing worker-scoped HULY_API_TOKEN_<WORKER> credential')
        raise RuntimeError('missing HULY_API_TOKEN/HULY_TOKEN')

    base_url = normalize_api_base_url(base_url_raw) if for_platform_api else base_url_raw.rstrip('/')

    workspace_id = args.workspace_id.strip() if args.workspace_id else ''
    if not workspace_id:
        workspace_id = env_first('HULY_WORKSPACE_ID')
    if not workspace_id:
        payload = decode_jwt_payload(token)
        workspace_id = str(payload.get('workspace') or '').strip()
    if not workspace_id and for_platform_api:
        raise RuntimeError('missing workspace id; set --workspace-id or HULY_WORKSPACE_ID')

    actor_id = args.actor_id.strip() if args.actor_id else ''
    if not actor_id and for_platform_api:
        account = api_call(
            method='GET',
            url=join_url(base_url, f'/api/v1/account/{workspace_id}'),
            token=token,
            timeout_seconds=args.timeout_seconds,
        )
        if isinstance(account, dict):
            actor_id = str(account.get('primarySocialId') or '').strip()
    if not actor_id and for_platform_api:
        raise RuntimeError('unable to resolve Huly actor id from account info')

    return HulyContext(
        base_url=base_url,
        token=token,
        token_source=token_source,
        workspace_id=workspace_id,
        actor_id=actor_id,
        timeout_seconds=args.timeout_seconds,
    )


def fetch_account_info(context: HulyContext) -> dict[str, Any]:
    account = api_call(
        method='GET',
        url=join_url(context.base_url, f'/api/v1/account/{context.workspace_id}'),
        token=context.token,
        timeout_seconds=context.timeout_seconds,
    )
    if not isinstance(account, dict):
        raise RuntimeError('invalid account response')
    return account


def run_account_info(args: argparse.Namespace) -> int:
    context = build_context(args, for_platform_api=True)
    account = fetch_account_info(context)
    actor_id = str(account.get('primarySocialId') or '').strip()
    if args.expected_actor_id.strip() and actor_id != args.expected_actor_id.strip():
        print(
            json.dumps(
                {
                    'error': 'expected_actor_id_mismatch',
                    'expectedActorId': args.expected_actor_id.strip(),
                    'actualActorId': actor_id,
                },
                indent=2,
                sort_keys=True,
            ),
            file=sys.stderr,
        )
        return 1

    output = {
        'workspaceId': context.workspace_id,
        'actorId': actor_id,
        'tokenSource': context.token_source,
        'workerScopedToken': context.token_source.startswith('HULY_API_TOKEN_'),
        'person': account.get('person'),
        'accountRole': account.get('role'),
        'workspaces': account.get('workspaces'),
    }
    print(json.dumps(output, indent=2, sort_keys=True))
    return 0


def run_http(args: argparse.Namespace) -> int:
    if not args.path:
        print('--path is required for --operation http', file=sys.stderr)
        return 2

    context = build_context(args, for_platform_api=False)

    method = args.method.upper().strip() or 'GET'
    url = join_url(context.base_url, args.path)

    body = None
    if args.data:
        body = maybe_parse_json(args.data)

    headers = parse_headers(args.header)
    try:
        response = api_call(
            method=method,
            url=url,
            token=context.token,
            timeout_seconds=context.timeout_seconds,
            data=body,
            extra_headers=headers,
        )
    except RuntimeError as error:
        print(str(error), file=sys.stderr)
        return 1

    if isinstance(response, (dict, list)):
        print(json.dumps(response, indent=2, sort_keys=True))
    else:
        print(str(response))
    return 0


def run_create_issue(args: argparse.Namespace) -> int:
    context = build_context(args, for_platform_api=True)
    title = args.title.strip()
    if not title:
        print('--title is required for create-issue', file=sys.stderr)
        return 2

    mission_id = args.mission_id.strip()
    body = args.body.strip()
    status = args.issue_status.strip() or DEFAULT_ISSUE_STATUS

    result = create_or_update_issue(
        context=context,
        project_ref=args.project,
        title=title,
        body=body,
        mission_id=mission_id,
        status=status,
        priority=args.priority,
    )
    print(json.dumps(result, indent=2, sort_keys=True))
    return 0


def run_create_document(args: argparse.Namespace) -> int:
    context = build_context(args, for_platform_api=True)
    title = args.title.strip()
    if not title:
        print('--title is required for create-document', file=sys.stderr)
        return 2

    mission_id = args.mission_id.strip()
    body = args.body.strip()

    result = create_or_update_document(
        context=context,
        teamspace_ref=args.teamspace,
        title=title,
        body=body,
        mission_id=mission_id,
    )
    print(json.dumps(result, indent=2, sort_keys=True))
    return 0


def run_post_channel_message(args: argparse.Namespace) -> int:
    context = build_context(args, for_platform_api=True)
    message = args.message.strip()
    if not message:
        print('--message is required for post-channel-message', file=sys.stderr)
        return 2

    result = post_channel_message(
        context=context,
        channel_ref=args.channel,
        message=message,
    )
    print(json.dumps(result, indent=2, sort_keys=True))
    return 0


def run_upsert_mission(args: argparse.Namespace) -> int:
    context = build_context(args, for_platform_api=True)

    mission_id = args.mission_id.strip()
    if not mission_id:
        print('--mission-id is required for upsert-mission', file=sys.stderr)
        return 2

    title = args.title.strip()
    if not title:
        print('--title is required for upsert-mission', file=sys.stderr)
        return 2

    summary = args.summary.strip()
    if not summary:
        print('--summary is required for upsert-mission', file=sys.stderr)
        return 2

    stage = args.stage.strip() or 'unknown'
    status = args.status.strip() or 'in-progress'
    details = args.details.strip()

    issue_body = summary
    if details:
        issue_body = f'{summary}\n\n{details}'

    document_body = (
        f'# {title}\n\n'
        f'## Mission\n{mission_id}\n\n'
        f'## Stage\n{stage}\n\n'
        f'## Status\n{status}\n\n'
        f'## Summary\n{summary}\n'
    )
    if details:
        document_body += f'\n## Details\n{details}\n'

    issue_result = create_or_update_issue(
        context=context,
        project_ref=args.project,
        title=title,
        body=issue_body,
        mission_id=mission_id,
        status=args.issue_status.strip() or DEFAULT_ISSUE_STATUS,
        priority=args.priority,
    )

    document_result = create_or_update_document(
        context=context,
        teamspace_ref=args.teamspace,
        title=title,
        body=document_body,
        mission_id=mission_id,
    )

    channel_message = (
        f'[{stage}] [{status}] mission={mission_id}\\n'
        f'title={title}\\n'
        f'summary={summary}\\n'
        f'issueId={issue_result.get("issueId", "")} '
        f'documentId={document_result.get("documentId", "")}'
    )
    channel_result = post_channel_message(
        context=context,
        channel_ref=args.channel,
        message=channel_message,
    )

    output = {
        'missionId': mission_id,
        'stage': stage,
        'status': status,
        'issue': issue_result,
        'document': document_result,
        'channelMessage': channel_result,
        'apiBaseUrl': context.base_url,
        'workspaceId': context.workspace_id,
    }
    print(json.dumps(output, indent=2, sort_keys=True))
    return 0


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description='Call Huly endpoints and mission helpers with bearer auth.')
    parser.add_argument(
        '--operation',
        default='http',
        choices=['http', 'create-issue', 'create-document', 'post-channel-message', 'upsert-mission', 'account-info'],
        help='Operation mode',
    )

    # Shared auth/runtime flags.
    parser.add_argument('--token', default='', help='Override bearer token (defaults to env)')
    parser.add_argument(
        '--token-env-key',
        default='',
        help='Specific env var name containing bearer token (for per-worker accounts)',
    )
    parser.add_argument('--worker-id', default='', help='Worker id used to resolve per-worker token env vars')
    parser.add_argument('--worker-identity', default='', help='Worker identity used to resolve per-worker token env vars')
    parser.add_argument(
        '--require-worker-token',
        action='store_true',
        help='Fail unless token was resolved from a worker-specific env var',
    )
    parser.add_argument(
        '--base-url',
        default='',
        help='Override base URL (defaults to HULY_API_BASE_URL or HULY_BASE_URL)',
    )
    parser.add_argument('--workspace-id', default='', help='Override workspace id (defaults to JWT payload or env)')
    parser.add_argument('--actor-id', default='', help='Override actor id / primarySocialId')
    parser.add_argument('--timeout-seconds', type=int, default=30, help='Request timeout')

    # Raw HTTP mode.
    parser.add_argument('--method', default='GET', help='HTTP method for --operation http')
    parser.add_argument('--path', default='', help='API path for --operation http, for example /api/version')
    parser.add_argument('--data', default='', help='JSON payload for --operation http')
    parser.add_argument('--header', action='append', default=[], help='Extra header in key:value format')

    # Huly workspace objects.
    parser.add_argument('--project', default=env_first('HULY_PROJECT'), help='Project identifier/name/id for tasks')
    parser.add_argument(
        '--teamspace',
        default=env_first('HULY_TEAMSPACE') or DEFAULT_TEAMSPACE,
        help='Teamspace name/id for documents',
    )
    parser.add_argument('--channel', default=env_first('HULY_CHANNEL') or 'general', help='Channel name/id for chat')

    # Artifact payload.
    parser.add_argument('--mission-id', default='', help='Mission id used for upsert and artifact titles')
    parser.add_argument('--title', default='', help='Artifact title')
    parser.add_argument('--body', default='', help='Body text for issue/document operations')
    parser.add_argument('--message', default='', help='Chat message body for post-channel-message')
    parser.add_argument('--summary', default='', help='Mission summary for upsert-mission')
    parser.add_argument('--details', default='', help='Mission details for upsert-mission')
    parser.add_argument('--stage', default='', help='Mission stage label for upsert-mission')
    parser.add_argument('--status', default='', help='Mission status label for upsert-mission')
    parser.add_argument('--issue-status', default=DEFAULT_ISSUE_STATUS, help='Issue status id for task artifacts')
    parser.add_argument('--priority', type=int, default=0, help='Issue priority for task artifacts')
    parser.add_argument(
        '--expected-actor-id',
        default='',
        help='When set, account-info fails unless current token resolves to this actor id',
    )

    return parser


def main() -> int:
    parser = build_parser()
    args = parser.parse_args()

    try:
        if args.operation == 'http':
            return run_http(args)
        if args.operation == 'create-issue':
            return run_create_issue(args)
        if args.operation == 'create-document':
            return run_create_document(args)
        if args.operation == 'post-channel-message':
            return run_post_channel_message(args)
        if args.operation == 'upsert-mission':
            return run_upsert_mission(args)
        if args.operation == 'account-info':
            return run_account_info(args)
        print(f'unsupported operation: {args.operation}', file=sys.stderr)
        return 2
    except ValueError as error:
        print(str(error), file=sys.stderr)
        return 2
    except RuntimeError as error:
        print(str(error), file=sys.stderr)
        return 1


if __name__ == '__main__':
    sys.exit(main())
