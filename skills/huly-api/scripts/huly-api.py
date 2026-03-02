#!/usr/bin/env python3
"""Minimal authenticated Huly API client for swarm agents."""

import argparse
import json
import os
import re
import sys
import uuid
import urllib.error
import urllib.parse
import urllib.request
from typing import Any


def env_first(*keys: str) -> str:
    for key in keys:
        value = os.getenv(key, '').strip()
        if value:
            return value
    return ''


def join_url(base_url: str, path: str) -> str:
    normalized_base = base_url.rstrip('/')
    normalized_path = path if path.startswith('/') else f'/{path}'
    return f'{normalized_base}{normalized_path}'


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


def random_object_id(prefix: str = '') -> str:
    random_suffix = uuid.uuid4().hex[:24]
    return f'{prefix}{random_suffix}' if prefix else random_suffix


def slugify(value: str, fallback: str = 'mission', max_length: int = 72) -> str:
    candidate = re.sub(r'[^a-z0-9-]+', '-', value.lower().strip().replace(' ', '-'))
    candidate = re.sub(r'-+', '-', candidate).strip('-')
    if not candidate:
        candidate = fallback
    if len(candidate) > max_length:
        candidate = candidate[:max_length].strip('-')
    return candidate


def truncate(value: str, limit: int = 1800) -> str:
    if not value:
        return ''
    if len(value) <= limit:
        return value
    if limit <= 3:
        return value[:limit]
    return f'{value[: limit - 3].rstrip()}...'


def coalesce(value: Any) -> str:
    if value is None:
        return ''
    if isinstance(value, str):
        return value.strip()
    return str(value).strip()


def is_huly_channel(channel: str) -> bool:
    lowered = channel.lower().strip()
    return lowered.startswith('huly://') or 'huly' in lowered


def normalize_payload(value: Any) -> str:
    if isinstance(value, (dict, list)):
        return json.dumps(value, sort_keys=True, indent=2)
    return coalesce(value)


def request_json(
    base_url: str,
    token: str,
    path: str,
    method: str = 'GET',
    payload: Any | None = None,
    timeout_seconds: int = 30,
    headers: dict[str, str] | None = None,
) -> tuple[int, Any, str]:
    request_headers = {
        'Accept': 'application/json',
        'Authorization': f'Bearer {token}',
    }
    if headers:
        request_headers.update(headers)

    body = None
    if payload is not None:
        if isinstance(payload, (dict, list)):
            body = json.dumps(payload).encode('utf-8')
            request_headers.setdefault('Content-Type', 'application/json')
        else:
            body = str(payload).encode('utf-8')
            request_headers.setdefault('Content-Type', 'text/plain; charset=utf-8')

    request = urllib.request.Request(
        url=join_url(base_url, path),
        method=method,
        headers=request_headers,
        data=body,
    )

    try:
        with urllib.request.urlopen(request, timeout=timeout_seconds) as response:
            raw_body = response.read().decode('utf-8', errors='replace')
            content_type = response.headers.get('Content-Type', '')
            parsed = (
                maybe_parse_json(raw_body)
                if 'json' in content_type.lower()
                else raw_body
            )
            return response.getcode(), parsed, raw_body
    except urllib.error.HTTPError as error:
        raw_error = error.read().decode('utf-8', errors='replace')
        raise RuntimeError(
            json.dumps(
                {
                    'status': error.code,
                    'reason': error.reason,
                    'url': join_url(base_url, path),
                    'body': maybe_parse_json(raw_error),
                },
                sort_keys=True,
            )
        ) from error


def find_all(
    base_url: str,
    token: str,
    workspace: str,
    cls: str,
    query: dict[str, Any] | None = None,
    limit: int = 1,
) -> list[dict[str, Any]]:
    params = {'class': cls, 'limit': str(limit)}
    if query:
        params['query'] = json.dumps(query, separators=(',', ':'), sort_keys=True)

    query_string = urllib.parse.urlencode(params, safe=':')
    path = f'/api/v1/find-all/{workspace}?{query_string}'
    _, result, _ = request_json(base_url, token, path, 'GET')

    if isinstance(result, dict):
        return result.get('value', []) or []
    return []


def find_first_by_field(
    base_url: str,
    token: str,
    workspace: str,
    cls: str,
    field: str,
    value: str,
) -> dict[str, Any] | None:
    matches = find_all(base_url, token, workspace, cls, query={field: value}, limit=1)
    return matches[0] if matches else None


def find_messages_for_channel(
    base_url: str,
    token: str,
    workspace: str,
    channel_id: str,
) -> list[dict[str, Any]]:
    return find_all(
        base_url,
        token,
        workspace,
        'chunter:class:ChatMessage',
        query={'attachedTo': channel_id, 'collection': 'messages'},
        limit=200,
    )


def send_tx(
    base_url: str,
    token: str,
    workspace: str,
    tx: dict[str, Any],
) -> dict[str, Any]:
    path = f'/api/v1/tx/{workspace}'
    status, result, _ = request_json(base_url, token, path, 'POST', tx)
    if status >= 400:
        raise RuntimeError(f'tx request failed ({status}): {result}')
    if not isinstance(result, dict):
        return {}
    return result


def resolve_tracker_project(base_url: str, token: str, workspace: str, ref: str) -> str:
    if not ref:
        raise ValueError('project missing: set --data.hulyProject or HULY_PROJECT')

    direct = find_first_by_field(base_url, token, workspace, 'tracker:class:Project', '_id', ref)
    if direct:
        return direct.get('_id', ref)

    if ':' in ref:
        return ref

    by_name = find_first_by_field(base_url, token, workspace, 'tracker:class:Project', 'name', ref)
    if by_name:
        return by_name.get('_id', ref)

    by_title = find_first_by_field(base_url, token, workspace, 'tracker:class:Project', 'title', ref)
    if by_title:
        return by_title.get('_id', ref)

    default_project = find_first_by_field(
        base_url,
        token,
        workspace,
        'tracker:class:Project',
        '_id',
        'tracker:project:DefaultProject',
    )
    if default_project:
        return default_project.get('_id', 'tracker:project:DefaultProject')

    fallback_project = find_first_by_field(
        base_url,
        token,
        workspace,
        'tracker:class:Project',
        'name',
        'Welcome to Huly!',
    )
    if fallback_project:
        return fallback_project.get('_id', 'tracker:project:DefaultProject')

    return ref


def resolve_teamspace(base_url: str, token: str, workspace: str, ref: str) -> str:
    if not ref:
        raise ValueError('teamspace missing: set --data.hulyTeamspaceName or HULY_TEAMSPACE')

    direct = find_first_by_field(base_url, token, workspace, 'document:class:Teamspace', '_id', ref)
    if direct:
        return direct.get('_id', ref)

    by_title = find_first_by_field(base_url, token, workspace, 'document:class:Teamspace', 'title', ref)
    if by_title:
        return by_title.get('_id', ref)

    by_name = find_first_by_field(base_url, token, workspace, 'document:class:Teamspace', 'name', ref)
    if by_name:
        return by_name.get('_id', ref)

    return ref


def resolve_channel(base_url: str, token: str, workspace: str, ref: str) -> str:
    if not ref:
        raise ValueError('channel missing: set --data.hulyChannelName or HULY_CHANNEL')

    direct = find_first_by_field(base_url, token, workspace, 'chunter:class:Channel', '_id', ref)
    if direct:
        return direct.get('_id', ref)

    by_name = find_first_by_field(base_url, token, workspace, 'chunter:class:Channel', 'name', ref)
    if by_name:
        return by_name.get('_id', ref)

    return ref


def next_issue_identifier(base_url: str, token: str, workspace: str, project_id: str) -> tuple[str, int]:
    issues = find_all(
        base_url,
        token,
        workspace,
        'tracker:class:Issue',
        query={'attachedTo': project_id},
        limit=200,
    )

    highest = 9000
    prefix = 'HULY'
    for issue in issues:
        identifier = coalesce(issue.get('identifier'))
        match = re.match(r'([A-Za-z0-9_-]+)-(\d+)$', identifier)
        if match:
            prefix = match.group(1)
            highest = max(highest, int(match.group(2)))

    return f'{prefix}-{highest + 1}', highest + 1


def build_mission_code(data: dict[str, Any]) -> tuple[str, str, str, str]:
    swarm_name = coalesce(data.get('swarmName') or os.getenv('SWARM_NAME') or 'jangar')
    stage = coalesce(data.get('stage') or data.get('swarmStage') or data.get('phase') or 'implement')
    objective = coalesce(
        data.get('objective')
        or data.get('objectiveSummary')
        or os.getenv('ISSUE_TITLE')
        or os.getenv('CODEX_PROMPT')
        or 'mission'
    )

    code = slugify(f'{swarm_name}-{stage}-{objective}', fallback='mission', max_length=58)
    issue_title = f'[{slugify(swarm_name, fallback="swarm", max_length=24)}][{stage}] {truncate(objective, 90)}'
    return code, issue_title, stage, objective


def build_mission_scope(data: dict[str, Any]) -> tuple[str, str]:
    requirement_channel = coalesce(data.get('swarmRequirementChannel'))
    requirement_description = coalesce(data.get('swarmRequirementDescription'))
    requirement_payload = data.get('swarmRequirementPayload')

    if is_huly_channel(requirement_channel) and (requirement_description or requirement_payload):
        return 'cross-swarm', normalize_payload(requirement_payload or requirement_description)

    objective = coalesce(
        data.get('objective')
        or data.get('objectiveSummary')
        or os.getenv('CODEX_PROMPT')
        or 'No objective provided.'
    )
    return 'normal', objective


def build_issue_description(
    mission_code: str,
    stage: str,
    status: str,
    scope_kind: str,
    scope_text: str,
    data: dict[str, Any],
    worker_id: str,
    worker_identity: str,
) -> str:
    objective_type = coalesce(data.get('objective') or data.get('objectiveSummary'))
    lines = [
        f'Mission `{mission_code}`',
        '',
        f'- Stage: {stage}',
        f'- Status: {status}',
        f'- Objective type: {scope_kind}',
        '',
        '## Summary',
        truncate(scope_text, 1500),
        '',
        '## Execution Identity',
        f'- swarmAgentWorkerId: `{worker_id}`',
        f'- swarmAgentIdentity: `{worker_identity}`',
        '',
    ]

    if scope_kind == 'cross-swarm':
        lines.extend(
            [
                '## Cross-Swarm Requirement',
                f'- Requirement source: `{coalesce(data.get("swarmRequirementSource") ) or "N/A"}`',
                f'- Requirement target: `{coalesce(data.get("swarmRequirementTarget") ) or "N/A"}`',
                f'- Requirement channel: `{coalesce(data.get("swarmRequirementChannel") ) or "N/A"}`',
                f'- Requirement signal: `{coalesce(data.get("swarmRequirementSignal") ) or "N/A"}`',
                f'- Requirement id: `{coalesce(data.get("swarmRequirementId") ) or "N/A"}`',
                '',
            ],
        )

    lines.extend(
        [
            '## Cross-links',
            f'- Repository: {coalesce(data.get("repository") or os.getenv("REPOSITORY") or os.getenv("REPO") ) or "N/A"}',
            f'- Branch: {coalesce(data.get("head") or os.getenv("HEAD_BRANCH") ) or "N/A"}',
            f'- Base: {coalesce(data.get("base") or os.getenv("BASE_BRANCH") ) or "N/A"}',
            f'- Objective: {objective_type or "N/A"}',
        ]
    )

    return '\n'.join(lines)


def build_document_body(
    mission_code: str,
    stage: str,
    status: str,
    scope_kind: str,
    scope_text: str,
    data: dict[str, Any],
    worker_id: str,
    worker_identity: str,
) -> str:
    title = coalesce(data.get('objective') or data.get('objectiveSummary') or 'Mission')

    lines = [
        f'# {mission_code} - {title}',
        '',
        f'**Stage:** {stage}',
        f'**Status:** {status}',
        f'**Scope source:** {scope_kind}',
        '',
        '## Summary',
        truncate(scope_text, 1800),
        '',
        '## Execution Identity',
        f'- `swarmAgentWorkerId`: `{worker_id}`',
        f'- `swarmAgentIdentity`: `{worker_identity}`',
        '',
    ]

    if scope_kind == 'cross-swarm':
        lines.extend(
            [
                '## Requirement Provenance',
                f'- **source**: {coalesce(data.get("swarmRequirementSource") ) or "N/A"}',
                f'- **target**: {coalesce(data.get("swarmRequirementTarget") ) or "N/A"}',
                f'- **channel**: {coalesce(data.get("swarmRequirementChannel") ) or "N/A"}',
                f'- **signal**: {coalesce(data.get("swarmRequirementSignal") ) or "N/A"}',
                f'- **id**: {coalesce(data.get("swarmRequirementId") ) or "N/A"}',
                f'- **payload**: ```\n{truncate(normalize_payload(data.get("swarmRequirementPayload") or ""), 600)}\n```',
                '',
            ],
        )

    lines.extend(
        [
            '## References',
            f'- Repository: {coalesce(data.get("repository") or os.getenv("REPOSITORY") or os.getenv("REPO") ) or "N/A"}',
            f'- Owner channel: `{coalesce(data.get("ownerChannel") ) or coalesce(os.getenv("HULY_CHANNEL")) or "general"}`',
            f'- Head: `{coalesce(data.get("head") or os.getenv("HEAD_BRANCH") ) or "N/A"}`',
            f'- Base: `{coalesce(data.get("base") or os.getenv("BASE_BRANCH") ) or "N/A"}`',
            '',
            '## Huly Artifact IDs',
            '- Issue ID: pending',
            '- Document ID: pending',
            '- Message ID: pending',
            '',
        ],
    )

    return '\n'.join(lines)


def build_status_message(
    mission_code: str,
    issue: dict[str, Any] | None,
    document: dict[str, Any] | None,
    status: str,
    stage: str,
    data: dict[str, Any],
    worker_id: str,
    worker_identity: str,
) -> str:
    title = coalesce(data.get('objective') or data.get('objectiveSummary') or 'Mission')
    req_channel = coalesce(data.get('swarmRequirementChannel') )
    provenance = f'source={coalesce(data.get("swarmRequirementSource") )} target={coalesce(data.get("swarmRequirementTarget") )}'
    if not req_channel:
        provenance = 'source=n/a target=n/a'

    return '\n'.join(
        [
            f'[{coalesce(data.get("swarmName") or "jangar")}][{status}] mission={mission_code}',
            f'stage={stage}',
            f'title={truncate(title, 120)}',
            f'summary={truncate(coalesce(data.get("objective") or data.get("objectiveSummary") or ""), 260)}',
            f'provenance={provenance}',
            f'worker={worker_id}/{worker_identity}',
            f'issueId={coalesce(issue.get("_id") if issue else "pending")}',
            f'documentId={coalesce(document.get("_id") if document else "pending")}',
        ],
    )


def find_channel_message_by_mission(
    base_url: str,
    token: str,
    workspace: str,
    channel_id: str,
    mission_code: str,
    issue_id: str | None = None,
) -> dict[str, Any] | None:
    messages = find_messages_for_channel(base_url, token, workspace, channel_id)
    for message in messages:
        message_text = coalesce(message.get('message'))
        if f'mission={mission_code}' not in message_text:
            continue
        if issue_id and issue_id in message_text:
            return message
    for message in messages:
        if f'mission={mission_code}' in coalesce(message.get('message')):
            return message
    return None


def upsert_mission(base_url: str, token: str, workspace: str, data: dict[str, Any]) -> dict[str, Any]:
    if not workspace:
        raise ValueError('workspace missing: set --data.hulyWorkspace or HULY_WORKSPACE')

    mission_code, issue_title, stage, objective = build_mission_code(data)
    scope_kind, scope_text = build_mission_scope(data)
    status = coalesce(data.get('status') or data.get('state') or 'running')

    worker_id = coalesce(data.get('swarmAgentWorkerId') or os.getenv('SWARM_AGENT_WORKER_ID'))
    worker_identity = coalesce(data.get('swarmAgentIdentity') or os.getenv('SWARM_AGENT_IDENTITY'))
    if not worker_id:
        worker_id = 'N/A'
    if not worker_identity:
        worker_identity = 'N/A'

    project_ref = coalesce(data.get('hulyProject') or os.getenv('HULY_PROJECT') or os.getenv('HULY_PROJECT_ID'))
    teamspace_ref = coalesce(data.get('hulyTeamspaceName') or os.getenv('HULY_TEAMSPACE') or os.getenv('HULY_TEAMSPACE_NAME'))
    channel_name = coalesce(data.get('hulyChannelName') or os.getenv('HULY_CHANNEL') or 'general')

    project_id = resolve_tracker_project(base_url, token, workspace, project_ref)
    teamspace_id = resolve_teamspace(base_url, token, workspace, teamspace_ref)
    channel_id = resolve_channel(base_url, token, workspace, channel_name)

    issue_title_exact = issue_title
    issue = find_first_by_field(
        base_url,
        token,
        workspace,
        'tracker:class:Issue',
        'title',
        issue_title_exact,
    )
    document = find_first_by_field(
        base_url,
        token,
        workspace,
        'document:class:Document',
        'title',
        issue_title_exact,
    )

    issue_description = build_issue_description(
        mission_code,
        stage,
        status,
        scope_kind,
        scope_text,
        data,
        worker_id,
        worker_identity,
    )
    document_content = build_document_body(
        mission_code,
        stage,
        status,
        scope_kind,
        scope_text,
        data,
        worker_id,
        worker_identity,
    )

    if issue:
        issue_tx = {
            '_class': 'core:class:TxUpdateDoc',
            '_id': random_object_id(),
            'space': 'core:space:Tx',
            'objectId': issue['_id'],
            'objectSpace': issue['space'],
            'operations': {'title': issue_title_exact, 'description': issue_description},
        }
        send_tx(base_url, token, workspace, issue_tx)
    else:
        identifier, number = next_issue_identifier(base_url, token, workspace, project_id)
        issue_tx = {
            '_class': 'core:class:TxCreateDoc',
            '_id': random_object_id(),
            'space': 'core:space:Tx',
            'objectClass': 'tracker:class:Issue',
            'objectId': random_object_id(),
            'objectSpace': project_id,
            'collection': 'issues',
            'attachedTo': project_id,
            'attachedToClass': 'tracker:class:Project',
            'attributes': {
                'title': issue_title_exact,
                'description': issue_description,
                'status': 'tracker:status:Backlog',
                'identifier': identifier,
                'number': number,
                'kind': 'tracker:taskTypes:Issue',
                'assignee': None,
                'component': None,
                'estimation': 0,
                'remainingTime': 0,
                'reportedTime': 0,
                'comments': 0,
                'subIssues': 0,
                'parents': [],
                'childInfo': [],
                'attachedTo': 'tracker:ids:NoParent',
                'attachedToClass': 'tracker:class:Issue',
                'collection': 'subIssues',
                'dueDate': None,
                'rank': '0|zzzzzz:',
            },
        }
        send_tx(base_url, token, workspace, issue_tx)

    if document:
        document_tx = {
            '_class': 'core:class:TxUpdateDoc',
            '_id': random_object_id(),
            'space': 'core:space:Tx',
            'objectId': document['_id'],
            'objectSpace': document['space'],
            'operations': {'title': issue_title_exact, 'content': document_content},
        }
        send_tx(base_url, token, workspace, document_tx)
    else:
        document_tx = {
            '_class': 'core:class:TxCreateDoc',
            '_id': random_object_id(),
            'space': 'core:space:Tx',
            'objectClass': 'document:class:Document',
            'objectId': random_object_id(),
            'objectSpace': teamspace_id,
            'attributes': {
                'title': issue_title_exact,
                'content': document_content,
                'parent': 'document:ids:NoParent',
                'rank': '0|zzzzzz:',
            },
        }
        send_tx(base_url, token, workspace, document_tx)

    issue = find_first_by_field(
        base_url,
        token,
        workspace,
        'tracker:class:Issue',
        'title',
        issue_title_exact,
    )
    document = find_first_by_field(
        base_url,
        token,
        workspace,
        'document:class:Document',
        'title',
        issue_title_exact,
    )

    status_message = build_status_message(
        mission_code,
        issue,
        document,
        status,
        stage,
        data,
        worker_id,
        worker_identity,
    )

    existing_message = find_channel_message_by_mission(
        base_url,
        token,
        workspace,
        channel_id,
        mission_code,
        coalesce(issue.get('_id') if issue else None),
    )

    if existing_message:
        message_tx = {
            '_class': 'core:class:TxUpdateDoc',
            '_id': random_object_id(),
            'space': 'core:space:Tx',
            'objectId': existing_message['_id'],
            'objectSpace': existing_message['space'],
            'operations': {'message': status_message},
        }
    else:
        message_tx = {
            '_class': 'core:class:TxCreateDoc',
            '_id': random_object_id(),
            'space': 'core:space:Tx',
            'objectClass': 'chunter:class:ChatMessage',
            'objectId': random_object_id(),
            'objectSpace': channel_id,
            'collection': 'messages',
            'attachedTo': channel_id,
            'attachedToClass': 'chunter:class:Channel',
            'attributes': {'message': status_message},
        }

    send_tx(base_url, token, workspace, message_tx)

    message = find_channel_message_by_mission(
        base_url,
        token,
        workspace,
        channel_id,
        mission_code,
        coalesce(issue.get('_id') if issue else None),
    )

    return {
        'operation': 'upsert-mission',
        'missionCode': mission_code,
        'issueId': coalesce(issue.get('_id') if issue else ''),
        'documentId': coalesce(document.get('_id') if document else ''),
        'messageId': coalesce(message.get('_id') if message else ''),
        'issueTitle': issue_title_exact,
        'status': status,
        'stage': stage,
        'objective': truncate(objective, 200),
        'issueDescriptionPreview': truncate(issue_description, 120),
        'documentPreview': truncate(document_content, 120),
        'statusMessage': truncate(status_message, 200),
        'requirementChannel': coalesce(data.get('swarmRequirementChannel')),
        'requirementId': coalesce(data.get('swarmRequirementId')),
    }


def parse_payload(raw: str) -> dict[str, Any]:
    payload = maybe_parse_json(raw)
    if not isinstance(payload, dict):
        raise ValueError('payload must be a JSON object')
    return payload


def main() -> int:
    parser = argparse.ArgumentParser(description='Call Huly API endpoints with bearer auth.')
    parser.add_argument('--operation', default='', help='Special operation mode, e.g. upsert-mission')
    parser.add_argument('--method', default='GET', help='HTTP method')
    parser.add_argument('--path', required=False, default='/api/version', help='API path, for example /api/issues')
    parser.add_argument('--data', default='', help='JSON payload string for write operations')
    parser.add_argument('--token', default='', help='Override bearer token (defaults to env)')
    parser.add_argument(
        '--base-url',
        default='',
        help='Override base URL (defaults to HULY_API_BASE_URL or HULY_BASE_URL)',
    )
    parser.add_argument('--header', action='append', default=[], help='Extra header in key:value format')
    parser.add_argument('--timeout-seconds', type=int, default=30, help='Request timeout')
    args = parser.parse_args()

    base_url = args.base_url.strip() or env_first('HULY_API_BASE_URL', 'HULY_BASE_URL')
    if not base_url:
        print('missing HULY_API_BASE_URL/HULY_BASE_URL', file=sys.stderr)
        return 2

    token = args.token.strip() or env_first('HULY_API_TOKEN', 'HULY_TOKEN')
    if not token:
        print('missing HULY_API_TOKEN/HULY_TOKEN', file=sys.stderr)
        return 2

    if args.operation == 'upsert-mission':
        payload = parse_payload(args.data)
        workspace = coalesce(
            payload.get('hulyWorkspace')
            or payload.get('workspace')
            or os.getenv('HULY_WORKSPACE')
            or os.getenv('HULY_WORKSPACE_ID')
        )

        try:
            result = upsert_mission(base_url=base_url, token=token, workspace=workspace, data=payload)
            print(json.dumps(result, indent=2, sort_keys=True))
            return 0
        except Exception as error:  # pragma: no cover - defensive exit path
            print(f'upsert-mission failed: {error}', file=sys.stderr)
            return 1

    method = args.method.upper().strip() or 'GET'

    payload = maybe_parse_json(args.data)
    request_data = payload if args.data else None
    request_headers = {
        'Authorization': f'Bearer {token}',
        'Accept': 'application/json',
    }
    request_headers.update(parse_headers(args.header))

    try:
        status, parsed, _ = request_json(
            base_url,
            token,
            args.path,
            method,
            payload=request_data,
            timeout_seconds=args.timeout_seconds,
            headers=request_headers,
        )
        if isinstance(parsed, (dict, list)):
            print(json.dumps(parsed, indent=2, sort_keys=True))
        else:
            print(parsed)
        return 0 if 200 <= status < 300 else 1
    except RuntimeError as error:
        print(error, file=sys.stderr)
        return 1
    except urllib.error.URLError as error:
        print(f'request failed: {error.reason}', file=sys.stderr)
        return 1


if __name__ == '__main__':
    sys.exit(main())
