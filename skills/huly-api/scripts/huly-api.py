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
import re
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
ISSUE_STATUS_IN_PROGRESS = 'tracker:status:InProgress'
ISSUE_STATUS_DONE = 'tracker:status:Done'
ISSUE_STATUS_CANCELED = 'tracker:status:Canceled'
DEFAULT_ISSUE_KIND = 'tracker:taskTypes:Issue'
DEFAULT_DOCUMENT_PARENT = 'document:ids:NoParent'
DEFAULT_RANK = '0|zzzzzz:'
DEFAULT_TEAMSPACE = 'PROOMPTENG'
DEFAULT_TRACKER_URL = 'https://huly.proompteng.ai/workbench/proompteng/tracker/tracker%3Aproject%3ADefaultProject/issues'
ISSUE_DESCRIPTION_ATTR = 'description'
DOCUMENT_CONTENT_ATTR = 'content'
COLLAB_REF_PATTERN = re.compile(r'^[A-Za-z0-9:_-]{16,}$')
MISSION_TITLE_PATTERN = re.compile(r'^\[mission:([^\]]+)\]\s*(.*)$')


@dataclass
class HulyContext:
    base_url: str
    collaborator_base_url: str
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


def resolve_worker_identity(args: argparse.Namespace) -> str:
    worker_identity = args.worker_identity.strip() if args.worker_identity else ''
    if worker_identity:
        return worker_identity
    return env_if_set('SWARM_AGENT_IDENTITY')


def resolve_mission_agent_identity(args: argparse.Namespace) -> str:
    explicit_agent_identity = (
        args.swarm_agent_identity.strip() if args.swarm_agent_identity else ''
    )
    if explicit_agent_identity:
        return explicit_agent_identity
    return resolve_worker_identity(args)


def resolve_worker_id(args: argparse.Namespace) -> str:
    worker_id = args.worker_id.strip() if args.worker_id else ''
    if worker_id:
        return worker_id
    return env_if_set('SWARM_AGENT_WORKER_ID')


def resolve_mission_agent_worker_id(args: argparse.Namespace) -> str:
    explicit_agent_id = args.swarm_agent_worker_id.strip() if args.swarm_agent_worker_id else ''
    if explicit_agent_id:
        return explicit_agent_id
    return resolve_worker_id(args)


def build_upsert_mission_metadata(*, args: argparse.Namespace) -> dict[str, str]:
    worker_id = resolve_mission_agent_worker_id(args)
    worker_identity = resolve_mission_agent_identity(args)
    human_name = args.swarm_human_name.strip() if args.swarm_human_name else ''
    team_name = args.swarm_team_name.strip() if args.swarm_team_name else ''
    swarm_name = args.swarm_name.strip() if args.swarm_name else ''
    tracker_url = args.tracker_url.strip() if args.tracker_url else ''

    if not human_name:
        human_name = 'Worker'
    if not team_name:
        team_name = 'Swarm Team'
    if not tracker_url:
        tracker_url = DEFAULT_TRACKER_URL

    metadata: dict[str, str] = {}
    if swarm_name:
        metadata['swarm'] = swarm_name
    if human_name:
        metadata['human'] = human_name
        metadata['team'] = team_name
    if worker_id:
        metadata['workerId'] = worker_id
    if worker_identity:
        metadata['workerIdentity'] = worker_identity
    if tracker_url:
        metadata['trackerUrl'] = tracker_url

    return metadata


def build_upsert_mission_context_section(*, metadata: dict[str, str], heading: str = 'Mission context') -> str:
    if not metadata:
        return ''

    lines: list[str] = []
    owner = metadata.get('human', '')
    team = metadata.get('team', '')
    if owner:
        if team:
            owner = f'{owner} ({team})'
        lines.append(f'- Owner: {owner}')

    if metadata.get('workerId') and metadata.get('workerIdentity'):
        lines.append(f"- Worker: {metadata['workerId']}/{metadata['workerIdentity']}")
    elif metadata.get('workerId'):
        lines.append(f"- Worker: {metadata['workerId']}")
    elif metadata.get('workerIdentity'):
        lines.append(f"- Worker: {metadata['workerIdentity']}")

    if metadata.get('trackerUrl'):
        lines.append(f"- Tracker: {metadata['trackerUrl']}")
    if metadata.get('swarm'):
        lines.append(f"- Swarm: {metadata['swarm']}")

    if not lines:
        return ''

    return f'## {heading}\n' + '\n'.join(lines)


def build_upsert_mission_context_message(*, metadata: dict[str, str]) -> str:
    if not metadata:
        return ''

    segments: list[str] = []
    owner = metadata.get('human', '')
    team = metadata.get('team', '')
    if owner:
        if team:
            segments.append(f'{owner} ({team})')
        else:
            segments.append(owner)

    worker_reference = ''
    if metadata.get('workerId') and metadata.get('workerIdentity'):
        worker_reference = f"{metadata['workerId']}/{metadata['workerIdentity']}"
    elif metadata.get('workerId'):
        worker_reference = metadata['workerId']
    elif metadata.get('workerIdentity'):
        worker_reference = metadata['workerIdentity']
    if worker_reference:
        segments.append(worker_reference)

    if metadata.get('trackerUrl'):
        segments.append(metadata['trackerUrl'])

    if not segments:
        return ''
    return ' | '.join(segments)


def is_worker_scoped_token_source(source: str) -> bool:
    return source.startswith('HULY_API_TOKEN_')


def resolve_expected_actor_id(args: argparse.Namespace) -> str:
    explicit = args.expected_actor_id.strip()
    if explicit:
        return explicit

    explicit_env_key = args.expected_actor_env_key.strip()
    if explicit_env_key:
        explicit_value = env_if_set(explicit_env_key)
        if explicit_value:
            return explicit_value

    worker_identity = args.worker_identity.strip() or env_if_set('SWARM_AGENT_IDENTITY')
    if worker_identity:
        key = f'HULY_EXPECTED_ACTOR_ID_{normalize_token_key(worker_identity)}'
        value = env_if_set(key)
        if value:
            return value

    worker_id = args.worker_id.strip() or env_if_set('SWARM_AGENT_WORKER_ID')
    if worker_id:
        key = f'HULY_EXPECTED_ACTOR_ID_{normalize_token_key(worker_id)}'
        value = env_if_set(key)
        if value:
            return value

    return ''


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


def normalize_text_block(value: str) -> str:
    text = value.strip()
    if not text:
        return ''

    # Some callers pass JSON-escaped string literals (for example: "line1\\nline2").
    if len(text) >= 2 and text[0] == '"' and text[-1] == '"':
        parsed = maybe_parse_json(text)
        if isinstance(parsed, str):
            text = parsed

    text = text.replace('\r\n', '\n').replace('\r', '\n')
    if '\\n' in text or '\\r' in text or '\\t' in text:
        text = text.replace('\\r\\n', '\n').replace('\\n', '\n').replace('\\r', '\n').replace('\\t', '\t')

    while '\n\n\n' in text:
        text = text.replace('\n\n\n', '\n\n')

    return text.strip()


def parse_headers(raw_headers: list[str]) -> dict[str, str]:
    headers: dict[str, str] = {}
    for header in raw_headers:
        if ':' not in header:
            raise ValueError(f'invalid header format (expected key:value): {header}')
        key, value = header.split(':', 1)
        headers[key.strip()] = value.strip()
    return headers


def build_mission_provenance(
    *,
    mission_id: str,
    stage: str,
    status: str,
    swarm_agent_worker_id: str = '',
    swarm_agent_identity: str = '',
) -> str:
    lines: list[str] = []
    if mission_id:
        lines.append(f'- missionId: {mission_id}')
    if stage:
        lines.append(f'- stage: {stage}')
    if status:
        lines.append(f'- status: {status}')
    if swarm_agent_worker_id:
        lines.append(f'- swarmAgentWorkerId: {swarm_agent_worker_id}')
    if swarm_agent_identity:
        lines.append(f'- swarmAgentIdentity: {swarm_agent_identity}')

    if not lines:
        return ''
    return '\n'.join(['### Mission Metadata', *lines])


def build_mission_provenance_compact(
    *,
    mission_id: str,
    stage: str,
    status: str,
    swarm_agent_worker_id: str = '',
    swarm_agent_identity: str = '',
) -> str:
    fields: list[str] = []
    if mission_id:
        fields.append(f'missionId={mission_id}')
    if stage:
        fields.append(f'stage={stage}')
    if status:
        fields.append(f'status={status}')
    if swarm_agent_worker_id:
        fields.append(f'swarmAgentWorkerId={swarm_agent_worker_id}')
    if swarm_agent_identity:
        fields.append(f'swarmAgentIdentity={swarm_agent_identity}')
    if not fields:
        return ''
    return 'Mission Metadata: ' + ' | '.join(fields)


def build_mission_document_body(
    *,
    mission_id: str,
    title: str,
    stage: str,
    status: str,
    summary: str,
    details: str,
    worker_update: str,
    metadata: str,
    context_section: str,
) -> str:
    sections: list[str] = [
        f'# {title}',
        '\n'.join(
            [
                '## Mission Snapshot',
                f'- Mission ID: {mission_id}',
                f'- Stage: {stage}',
                f'- Status: {status}',
            ]
        ),
        f'## Executive Summary\n{summary}',
        f'## Detailed Notes\n{details or "No additional detailed notes were provided for this stage."}',
        f'## Worker Update\n{worker_update}',
        '\n'.join(
            [
                '## Operational Follow-up',
                '- Link implementation evidence (PRs, rollout checks, and logs) in subsequent updates.',
                '- Keep this document updated with post-merge verification and rollback context if incidents occur.',
            ]
        ),
    ]
    if metadata:
        sections.append(metadata)
    if context_section:
        sections.append(context_section)
    return '\n\n'.join(section for section in sections if section)


def derive_issue_status_for_mission_status(mission_status: str) -> str:
    status = mission_status.strip().lower()
    if not status:
        return ''
    if any(token in status for token in ['done', 'complete', 'completed', 'success', 'succeeded', 'merged']):
        return ISSUE_STATUS_DONE
    if any(token in status for token in ['cancel', 'canceled', 'cancelled']):
        return ISSUE_STATUS_CANCELED
    if any(token in status for token in ['run', 'progress', 'active', 'verify', 'implement', 'discover', 'plan']):
        return ISSUE_STATUS_IN_PROGRESS
    return ''


def parse_mission_title(title: str) -> tuple[str, str]:
    match = MISSION_TITLE_PATTERN.match(title.strip())
    if not match:
        return '', title.strip()
    return match.group(1).strip(), match.group(2).strip()


def build_issue_backfill_description(*, mission_id: str, title: str, status: str) -> str:
    mission_reference = mission_id or 'unknown'
    title_reference = title or 'Untitled mission issue'
    status_reference = status or ISSUE_STATUS_IN_PROGRESS
    return (
        f'## Summary\n'
        f'Backfilled mission issue description for `{title_reference}`. '
        f'This issue previously had an empty body because legacy swarm writes did not persist a tracker description.\n\n'
        f'## Mission Context\n'
        f'- Mission ID: {mission_reference}\n'
        f'- Current Status: {status_reference}\n\n'
        f'## Next Actions\n'
        f'1. Add implementation evidence (PR links, CI checks, and rollout verification notes).\n'
        f'2. Keep status transitions aligned with real execution progress.\n'
        f'3. Mark Done only after production rollout health is verified.'
    )


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


def normalize_collaborator_base_url(base_url: str) -> str:
    raw = base_url.strip().rstrip('/')
    if not raw:
        return ''

    if raw.startswith('ws://'):
        raw = 'http://' + raw[len('ws://'):]
    elif raw.startswith('wss://'):
        raw = 'https://' + raw[len('wss://'):]

    parsed = urllib.parse.urlparse(raw)
    if not parsed.scheme or not parsed.netloc:
        return raw

    hostname = parsed.hostname or ''
    port = f':{parsed.port}' if parsed.port else ''
    target_hostname = hostname
    if hostname.lower().startswith('front.'):
        target_hostname = f"collaborator.{hostname[len('front.'):]}"
    elif hostname.lower().startswith('transactor.'):
        target_hostname = f"collaborator.{hostname[len('transactor.'):]}"

    return f'{parsed.scheme}://{target_hostname}{port}'


def derive_collaborator_base_url(api_base_url: str) -> str:
    parsed = urllib.parse.urlparse(api_base_url)
    if not parsed.scheme or not parsed.netloc:
        return ''

    hostname = parsed.hostname or ''
    port = f':{parsed.port}' if parsed.port else ''
    target_hostname = hostname
    if hostname.lower().startswith('transactor.'):
        target_hostname = f"collaborator.{hostname[len('transactor.'):]}"
    elif hostname.lower().startswith('front.'):
        target_hostname = f"collaborator.{hostname[len('front.'):]}"

    return f'{parsed.scheme}://{target_hostname}{port}'


def is_probable_collab_ref(value: str) -> bool:
    candidate = value.strip()
    if not candidate:
        return False
    if any(char.isspace() for char in candidate):
        return False
    return bool(COLLAB_REF_PATTERN.fullmatch(candidate))


def encode_document_id(
    *,
    workspace_id: str,
    object_class: str,
    object_id: str,
    object_attr: str = DOCUMENT_CONTENT_ATTR,
) -> str:
    return f'{workspace_id}|{object_class}|{object_id}|{object_attr}'


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
        if isinstance(data, (bytes, bytearray)):
            body = bytes(data)
        elif isinstance(data, str):
            body = data.encode('utf-8')
        else:
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


def collaborator_rpc(
    *,
    context: HulyContext,
    document_id: str,
    method: str,
    payload: dict[str, Any],
) -> dict[str, Any]:
    if not context.collaborator_base_url:
        raise RuntimeError('missing collaborator base url; set --collaborator-url or HULY_COLLABORATOR_URL')

    encoded_document_id = urllib.parse.quote(document_id, safe='')
    result = api_call(
        method='POST',
        url=join_url(context.collaborator_base_url, f'/rpc/{encoded_document_id}'),
        token=context.token,
        timeout_seconds=context.timeout_seconds,
        data={'method': method, 'payload': payload},
    )
    if not isinstance(result, dict):
        raise RuntimeError(f'collaborator {method} returned invalid response shape')
    error_message = result.get('error')
    if isinstance(error_message, str) and error_message.strip():
        raise RuntimeError(f'collaborator {method} failed: {error_message.strip()}')
    return result


def create_collab_content_ref(
    *,
    context: HulyContext,
    object_class: str,
    document_id: str,
    object_attr: str,
    content: str,
) -> str:
    document_name = encode_document_id(
        workspace_id=context.workspace_id,
        object_class=object_class,
        object_id=document_id,
        object_attr=object_attr,
    )
    result = collaborator_rpc(
        context=context,
        document_id=document_name,
        method='createContent',
        payload={'content': {object_attr: content}},
    )
    content_refs = result.get('content')
    if not isinstance(content_refs, dict):
        raise RuntimeError('collaborator createContent returned invalid content payload')
    content_ref = str(content_refs.get(object_attr) or '').strip()
    if not content_ref:
        raise RuntimeError('collaborator createContent did not return content reference')
    return content_ref


def update_collab_content_via_collaborator(
    *,
    context: HulyContext,
    object_class: str,
    document_id: str,
    object_attr: str,
    content: str,
) -> None:
    document_name = encode_document_id(
        workspace_id=context.workspace_id,
        object_class=object_class,
        object_id=document_id,
        object_attr=object_attr,
    )
    collaborator_rpc(
        context=context,
        document_id=document_name,
        method='updateContent',
        payload={'content': {object_attr: content}},
    )


def create_document_content_ref(
    *,
    context: HulyContext,
    document_id: str,
    content: str,
) -> str:
    return create_collab_content_ref(
        context=context,
        object_class=DOCUMENT_CLASS,
        document_id=document_id,
        object_attr=DOCUMENT_CONTENT_ATTR,
        content=content,
    )


def update_document_content_via_collaborator(
    *,
    context: HulyContext,
    document_id: str,
    content: str,
) -> None:
    update_collab_content_via_collaborator(
        context=context,
        object_class=DOCUMENT_CLASS,
        document_id=document_id,
        object_attr=DOCUMENT_CONTENT_ATTR,
        content=content,
    )


def create_issue_description_ref(
    *,
    context: HulyContext,
    issue_id: str,
    description: str,
) -> str:
    return create_collab_content_ref(
        context=context,
        object_class=ISSUE_CLASS,
        document_id=issue_id,
        object_attr=ISSUE_DESCRIPTION_ATTR,
        content=description,
    )


def update_issue_description_via_collaborator(
    *,
    context: HulyContext,
    issue_id: str,
    description: str,
) -> None:
    update_collab_content_via_collaborator(
        context=context,
        object_class=ISSUE_CLASS,
        document_id=issue_id,
        object_attr=ISSUE_DESCRIPTION_ATTR,
        content=description,
    )


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


def normalize_channel_ref(channel_ref: str) -> str:
    value = channel_ref.strip()
    if not value:
        return ''
    if value.startswith('huly://'):
        parsed = urllib.parse.urlparse(value)
        segments = [segment for segment in parsed.path.split('/') if segment]
        if len(segments) >= 2 and segments[0] == 'channels':
            return urllib.parse.unquote(segments[1]).strip()
        return urllib.parse.unquote(parsed.path.strip('/')).strip()
    if value.startswith('http://') or value.startswith('https://'):
        decoded = urllib.parse.unquote(urllib.parse.urlparse(value).path)
        marker = 'chunter:space:'
        if marker in decoded:
            return decoded.split(marker, 1)[1].split('|', 1)[0].strip().lower()
    return value


def resolve_channel(context: HulyContext, channel_ref: str) -> dict[str, Any]:
    channel_ref = normalize_channel_ref(channel_ref)
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


def find_issue_by_mission_id(context: HulyContext, project_id: str, mission_id: str) -> dict[str, Any] | None:
    mission_key = mission_id.strip()
    if not mission_key:
        return None
    mission_prefix = f'[mission:{mission_key}]'
    issues = find_all(
        context=context,
        class_name=ISSUE_CLASS,
        query={'space': project_id},
        options={'limit': 500, 'sort': {'modifiedOn': -1}},
    )
    for issue in issues:
        title = str(issue.get('title') or '').strip()
        if title.startswith(mission_prefix):
            return issue
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
    body = body.strip()
    requested_status = status.strip()
    project = resolve_project(context, project_ref)
    project_id = str(project.get('_id') or '')
    project_identifier = str(project.get('identifier') or '').strip()
    project_default_status = str(project.get('defaultIssueStatus') or '').strip()
    if not project_id:
        raise RuntimeError('resolved project is missing _id')

    mission_title = f'[mission:{mission_id}] {title}' if mission_id else title
    existing = find_issue_by_mission_id(context, project_id, mission_id) if mission_id else None
    if not existing:
        existing = find_issue_by_title(context, project_id, mission_title)
    if existing:
        issue_id = str(existing.get('_id') or '')
        if not issue_id:
            raise RuntimeError('resolved issue is missing _id')
        operations: dict[str, Any] = {
            'priority': priority,
            'title': mission_title,
        }
        if requested_status:
            operations['status'] = requested_status
        if body:
            existing_description = str(existing.get(ISSUE_DESCRIPTION_ATTR) or '').strip()
            try:
                description_ref = create_issue_description_ref(
                    context=context,
                    issue_id=issue_id,
                    description=body,
                )
                operations[ISSUE_DESCRIPTION_ATTR] = description_ref
            except RuntimeError as error:
                if 'already exists' in str(error).lower() and is_probable_collab_ref(existing_description):
                    update_issue_description_via_collaborator(
                        context=context,
                        issue_id=issue_id,
                        description=body,
                    )
                else:
                    raise
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
    issue_id = new_id()

    attributes: dict[str, Any] = {
        'title': mission_title,
        'status': requested_status or project_default_status or DEFAULT_ISSUE_STATUS,
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
        attributes[ISSUE_DESCRIPTION_ATTR] = create_issue_description_ref(
            context=context,
            issue_id=issue_id,
            description=body,
        )

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
    body = body.strip()
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
            existing_content = str(existing.get(DOCUMENT_CONTENT_ATTR) or '').strip()
            try:
                content_ref = create_document_content_ref(
                    context=context,
                    document_id=doc_id,
                    content=body,
                )
                operations[DOCUMENT_CONTENT_ATTR] = content_ref
            except RuntimeError as error:
                if 'already exists' in str(error).lower() and is_probable_collab_ref(existing_content):
                    update_document_content_via_collaborator(
                        context=context,
                        document_id=doc_id,
                        content=body,
                    )
                else:
                    raise
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

    doc_id = new_id()
    tx = create_tx_create_doc(
        actor_id=context.actor_id,
        object_class=DOCUMENT_CLASS,
        object_space=teamspace_id,
        object_id=doc_id,
        attributes=attributes,
    )
    submit_tx(context=context, payload=tx)

    if body:
        content_ref = create_document_content_ref(
            context=context,
            document_id=doc_id,
            content=body,
        )
        update_tx = create_tx_update_doc(
            actor_id=context.actor_id,
            object_class=DOCUMENT_CLASS,
            object_space=teamspace_id,
            object_id=doc_id,
            operations={DOCUMENT_CONTENT_ATTR: content_ref},
        )
        submit_tx(context=context, payload=update_tx)

    return {
        'action': 'created',
        'teamspaceId': teamspace_id,
        'documentId': doc_id,
        'documentTitle': mission_title,
    }


def repair_teamspace_documents(
    *,
    context: HulyContext,
    teamspace_ref: str,
    limit: int,
    mission_only: bool,
    dry_run: bool,
) -> dict[str, Any]:
    teamspace = resolve_teamspace(context, teamspace_ref)
    teamspace_id = str(teamspace.get('_id') or '')
    if not teamspace_id:
        raise RuntimeError('resolved teamspace is missing _id')

    safe_limit = max(1, min(limit, 1000))
    documents = find_all(
        context=context,
        class_name=DOCUMENT_CLASS,
        query={'space': teamspace_id},
        options={'limit': safe_limit, 'sort': {'modifiedOn': -1}},
    )

    scanned = 0
    converted = 0
    already_healthy = 0
    skipped_no_content = 0
    skipped_non_mission = 0
    updated_documents: list[dict[str, str]] = []

    for document in documents:
        scanned += 1
        doc_id = str(document.get('_id') or '').strip()
        title = str(document.get('title') or '').strip()
        content = str(document.get(DOCUMENT_CONTENT_ATTR) or '').strip()
        if not doc_id:
            continue
        if mission_only and not title.startswith('[mission:'):
            skipped_non_mission += 1
            continue
        if not content:
            skipped_no_content += 1
            continue
        if is_probable_collab_ref(content):
            already_healthy += 1
            continue

        if not dry_run:
            content_ref = create_document_content_ref(
                context=context,
                document_id=doc_id,
                content=content,
            )
            tx = create_tx_update_doc(
                actor_id=context.actor_id,
                object_class=DOCUMENT_CLASS,
                object_space=teamspace_id,
                object_id=doc_id,
                operations={DOCUMENT_CONTENT_ATTR: content_ref},
            )
            submit_tx(context=context, payload=tx)
        converted += 1
        updated_documents.append({'documentId': doc_id, 'title': title})

    return {
        'teamspaceId': teamspace_id,
        'teamspaceName': teamspace.get('name'),
        'scanned': scanned,
        'converted': converted,
        'alreadyHealthy': already_healthy,
        'skippedNoContent': skipped_no_content,
        'skippedNonMission': skipped_non_mission,
        'missionOnly': mission_only,
        'dryRun': dry_run,
        'updatedDocuments': updated_documents,
    }


def repair_project_issues(
    *,
    context: HulyContext,
    project_ref: str,
    limit: int,
    mission_only: bool,
    fill_empty_descriptions: bool,
    dry_run: bool,
) -> dict[str, Any]:
    project = resolve_project(context, project_ref)
    project_id = str(project.get('_id') or '')
    project_identifier = str(project.get('identifier') or '').strip()
    if not project_id:
        raise RuntimeError('resolved project is missing _id')

    safe_limit = max(1, min(limit, 1000))
    issues = find_all(
        context=context,
        class_name=ISSUE_CLASS,
        query={'space': project_id},
        options={'limit': safe_limit, 'sort': {'modifiedOn': -1}},
    )

    scanned = 0
    converted = 0
    already_healthy = 0
    skipped_no_description = 0
    skipped_non_mission = 0
    filled_empty = 0
    updated_issues: list[dict[str, str]] = []

    for issue in issues:
        scanned += 1
        issue_id = str(issue.get('_id') or '').strip()
        title = str(issue.get('title') or '').strip()
        description = str(issue.get(ISSUE_DESCRIPTION_ATTR) or '').strip()
        mission_id, _ = parse_mission_title(title)
        if not issue_id:
            continue
        if mission_only and not title.startswith('[mission:'):
            skipped_non_mission += 1
            continue
        if not description:
            if not fill_empty_descriptions:
                skipped_no_description += 1
                continue
            description = build_issue_backfill_description(
                mission_id=mission_id,
                title=title,
                status=str(issue.get('status') or ''),
            )
            filled_empty += 1
        if is_probable_collab_ref(description):
            already_healthy += 1
            continue

        if not dry_run:
            description_ref = create_issue_description_ref(
                context=context,
                issue_id=issue_id,
                description=description,
            )
            tx = create_tx_update_doc(
                actor_id=context.actor_id,
                object_class=ISSUE_CLASS,
                object_space=project_id,
                object_id=issue_id,
                operations={ISSUE_DESCRIPTION_ATTR: description_ref},
            )
            submit_tx(context=context, payload=tx)
        converted += 1
        updated_issues.append({'issueId': issue_id, 'title': title})

    return {
        'projectId': project_id,
        'projectIdentifier': project_identifier,
        'scanned': scanned,
        'converted': converted,
        'alreadyHealthy': already_healthy,
        'filledEmptyDescriptions': filled_empty,
        'skippedNoDescription': skipped_no_description,
        'skippedNonMission': skipped_non_mission,
        'missionOnly': mission_only,
        'fillEmptyDescriptions': fill_empty_descriptions,
        'dryRun': dry_run,
        'updatedIssues': updated_issues,
    }


def dedupe_project_mission_issues(
    *,
    context: HulyContext,
    project_ref: str,
    limit: int,
    dry_run: bool,
) -> dict[str, Any]:
    project = resolve_project(context, project_ref)
    project_id = str(project.get('_id') or '')
    project_identifier = str(project.get('identifier') or '').strip()
    if not project_id:
        raise RuntimeError('resolved project is missing _id')

    safe_limit = max(1, min(limit, 2000))
    issues = find_all(
        context=context,
        class_name=ISSUE_CLASS,
        query={'space': project_id},
        options={'limit': safe_limit, 'sort': {'modifiedOn': -1}},
    )

    mission_groups: dict[str, list[dict[str, Any]]] = {}
    for issue in issues:
        title = str(issue.get('title') or '').strip()
        mission_id, _ = parse_mission_title(title)
        if not mission_id:
            continue
        mission_groups.setdefault(mission_id, []).append(issue)

    duplicate_groups = 0
    canceled = 0
    already_canceled = 0
    plan: list[dict[str, Any]] = []

    for mission_id, grouped in mission_groups.items():
        if len(grouped) <= 1:
            continue
        duplicate_groups += 1

        primary = next(
            (
                issue
                for issue in grouped
                if str(issue.get('status') or '').strip() != ISSUE_STATUS_CANCELED
            ),
            grouped[0],
        )
        primary_id = str(primary.get('_id') or '').strip()
        cancel_ids: list[str] = []
        for issue in grouped:
            issue_id = str(issue.get('_id') or '').strip()
            if not issue_id or issue_id == primary_id:
                continue
            issue_status = str(issue.get('status') or '').strip()
            if issue_status == ISSUE_STATUS_CANCELED:
                already_canceled += 1
                continue
            cancel_ids.append(issue_id)
            if not dry_run:
                tx = create_tx_update_doc(
                    actor_id=context.actor_id,
                    object_class=ISSUE_CLASS,
                    object_space=project_id,
                    object_id=issue_id,
                    operations={'status': ISSUE_STATUS_CANCELED},
                )
                submit_tx(context=context, payload=tx)
            canceled += 1

        plan.append(
            {
                'missionId': mission_id,
                'keptIssueId': primary_id,
                'canceledIssueIds': cancel_ids,
            }
        )

    return {
        'projectId': project_id,
        'projectIdentifier': project_identifier,
        'scanned': len(issues),
        'missionGroups': len(mission_groups),
        'duplicateMissionGroups': duplicate_groups,
        'canceledDuplicates': canceled,
        'alreadyCanceledDuplicates': already_canceled,
        'dryRun': dry_run,
        'plan': plan,
    }


def post_channel_message(
    *,
    context: HulyContext,
    channel_ref: str,
    message: str,
    reply_to_message_id: str = '',
    reply_to_message_class: str = CHAT_MESSAGE_CLASS,
) -> dict[str, Any]:
    channel = resolve_channel(context, channel_ref)
    channel_id = str(channel.get('_id') or '')
    channel_name = str(channel.get('name') or '')
    if not channel_id:
        raise RuntimeError('resolved channel is missing _id')

    reply_parent_id = reply_to_message_id.strip()
    reply_parent_class = (reply_to_message_class or CHAT_MESSAGE_CLASS).strip() or CHAT_MESSAGE_CLASS
    attached_to = reply_parent_id or channel_id
    attached_to_class = reply_parent_class if reply_parent_id else CHANNEL_CLASS
    collection = 'replies' if reply_parent_id else 'messages'

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
        attached_to=attached_to,
        attached_to_class=attached_to_class,
        collection=collection,
        attributes=attributes,
    )
    submit_tx(context=context, payload=tx)

    return {
        'action': 'created',
        'channelId': channel_id,
        'channelName': channel_name,
        'messageId': message_id,
        'replyToMessageId': reply_parent_id or None,
        'replyToMessageClass': attached_to_class,
        'collection': collection,
    }


def list_channel_messages(
    *,
    context: HulyContext,
    channel_ref: str,
    limit: int,
) -> dict[str, Any]:
    channel = resolve_channel(context, channel_ref)
    channel_id = str(channel.get('_id') or '')
    channel_name = str(channel.get('name') or '')
    if not channel_id:
        raise RuntimeError('resolved channel is missing _id')

    safe_limit = max(1, min(limit, 200))
    messages = find_all(
        context=context,
        class_name=CHAT_MESSAGE_CLASS,
        query={'space': channel_id},
        options={'limit': safe_limit, 'sort': {'modifiedOn': -1}},
    )
    normalized: list[dict[str, Any]] = []
    for message in messages:
        normalized.append(
            {
                'messageId': message.get('_id'),
                'message': message.get('message', ''),
                'createdBy': message.get('createdBy'),
                'modifiedOn': message.get('modifiedOn'),
            }
        )
    return {
        'channelId': channel_id,
        'channelName': channel_name,
        'count': len(normalized),
        'messages': normalized,
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
    if args.require_worker_token and not is_worker_scoped_token_source(token_source):
        raise RuntimeError(
            f'require-worker-token rejected token source "{token_source}"; expected HULY_API_TOKEN_<WORKER>'
        )

    base_url = normalize_api_base_url(base_url_raw) if for_platform_api else base_url_raw.rstrip('/')
    collaborator_base_url = ''
    if for_platform_api:
        configured_collaborator_url = (
            args.collaborator_url.strip()
            if getattr(args, 'collaborator_url', None)
            else env_first('HULY_COLLABORATOR_URL', 'HULY_COLLABORATOR_BASE_URL')
        )
        if configured_collaborator_url:
            collaborator_base_url = normalize_collaborator_base_url(configured_collaborator_url)
        else:
            collaborator_base_url = derive_collaborator_base_url(base_url)

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
        collaborator_base_url=collaborator_base_url,
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
    expected_actor_id = resolve_expected_actor_id(args)
    if args.require_expected_actor_id and not expected_actor_id:
        print(
            json.dumps(
                {
                    'error': 'missing_expected_actor_id',
                    'message': 'set --expected-actor-id or HULY_EXPECTED_ACTOR_ID_<WORKER>',
                },
                indent=2,
                sort_keys=True,
            ),
            file=sys.stderr,
        )
        return 1
    if expected_actor_id and actor_id != expected_actor_id:
        print(
            json.dumps(
                {
                    'error': 'expected_actor_id_mismatch',
                    'expectedActorId': expected_actor_id,
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
        'expectedActorId': expected_actor_id,
        'tokenSource': context.token_source,
        'workerScopedToken': is_worker_scoped_token_source(context.token_source),
        'person': account.get('person'),
        'accountRole': account.get('role'),
        'workspaces': account.get('workspaces'),
    }
    print(json.dumps(output, indent=2, sort_keys=True))
    return 0


def run_verify_chat_access(args: argparse.Namespace) -> int:
    chat_message = normalize_text_block(args.message)
    if not chat_message:
        print('--message is required for verify-chat-access', file=sys.stderr)
        return 2

    context = build_context(args, for_platform_api=True)
    account = fetch_account_info(context)
    actor_id = str(account.get('primarySocialId') or '').strip()

    expected_actor_id = resolve_expected_actor_id(args)
    if args.require_expected_actor_id and not expected_actor_id:
        print(
            json.dumps(
                {
                    'error': 'missing_expected_actor_id',
                    'message': 'set --expected-actor-id or HULY_EXPECTED_ACTOR_ID_<WORKER>',
                },
                indent=2,
                sort_keys=True,
            ),
            file=sys.stderr,
        )
        return 1
    if expected_actor_id and actor_id != expected_actor_id:
        print(
            json.dumps(
                {
                    'error': 'expected_actor_id_mismatch',
                    'expectedActorId': expected_actor_id,
                    'actualActorId': actor_id,
                },
                indent=2,
                sort_keys=True,
            ),
            file=sys.stderr,
        )
        return 1

    channel_result = post_channel_message(
        context=context,
        channel_ref=args.channel,
        message=chat_message,
    )
    output = {
        'workspaceId': context.workspace_id,
        'actorId': actor_id,
        'expectedActorId': expected_actor_id,
        'tokenSource': context.token_source,
        'workerScopedToken': is_worker_scoped_token_source(context.token_source),
        'channelMessage': channel_result,
        'message': chat_message,
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
    status = args.issue_status.strip()

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
    message = normalize_text_block(args.message)
    if not message:
        print('--message is required for post-channel-message', file=sys.stderr)
        return 2

    result = post_channel_message(
        context=context,
        channel_ref=args.channel,
        message=message,
        reply_to_message_id=args.reply_to_message_id,
        reply_to_message_class=args.reply_to_message_class,
    )
    print(json.dumps(result, indent=2, sort_keys=True))
    return 0


def run_list_channel_messages(args: argparse.Namespace) -> int:
    context = build_context(args, for_platform_api=True)
    result = list_channel_messages(
        context=context,
        channel_ref=args.channel,
        limit=args.limit,
    )
    print(json.dumps(result, indent=2, sort_keys=True))
    return 0


def run_repair_teamspace_documents(args: argparse.Namespace) -> int:
    context = build_context(args, for_platform_api=True)
    result = repair_teamspace_documents(
        context=context,
        teamspace_ref=args.teamspace,
        limit=args.limit,
        mission_only=not args.include_non_mission_docs,
        dry_run=args.dry_run,
    )
    print(json.dumps(result, indent=2, sort_keys=True))
    return 0


def run_repair_project_issues(args: argparse.Namespace) -> int:
    context = build_context(args, for_platform_api=True)
    result = repair_project_issues(
        context=context,
        project_ref=args.project,
        limit=args.limit,
        mission_only=not args.include_non_mission_issues,
        fill_empty_descriptions=args.fill_empty_issue_descriptions,
        dry_run=args.dry_run,
    )
    print(json.dumps(result, indent=2, sort_keys=True))
    return 0


def run_dedupe_project_mission_issues(args: argparse.Namespace) -> int:
    context = build_context(args, for_platform_api=True)
    result = dedupe_project_mission_issues(
        context=context,
        project_ref=args.project,
        limit=args.limit,
        dry_run=args.dry_run,
    )
    print(json.dumps(result, indent=2, sort_keys=True))
    return 0


def run_upsert_mission(args: argparse.Namespace) -> int:
    mission_id = args.mission_id.strip()
    if not mission_id:
        print('--mission-id is required for upsert-mission', file=sys.stderr)
        return 2

    title = args.title.strip()
    if not title:
        print('--title is required for upsert-mission', file=sys.stderr)
        return 2

    summary = normalize_text_block(args.summary)
    if not summary:
        print('--summary is required for upsert-mission', file=sys.stderr)
        return 2
    channel_message = normalize_text_block(args.message)
    if not channel_message:
        print('--message is required for upsert-mission (worker-authored channel update)', file=sys.stderr)
        return 2

    context = build_context(args, for_platform_api=True)

    stage = args.stage.strip() or 'unknown'
    status = args.status.strip() or 'in-progress'
    details = normalize_text_block(args.details)
    swarm_agent_worker_id = (
        resolve_mission_agent_worker_id(args)
    )
    swarm_agent_identity = (
        resolve_mission_agent_identity(args)
    )

    metadata = build_mission_provenance(
        mission_id=mission_id,
        stage=stage,
        status=status,
        swarm_agent_worker_id=swarm_agent_worker_id,
        swarm_agent_identity=swarm_agent_identity,
    )
    channel_metadata_header = build_mission_provenance_compact(
        mission_id=mission_id,
        stage=stage,
        status=status,
        swarm_agent_worker_id=swarm_agent_worker_id,
        swarm_agent_identity=swarm_agent_identity,
    )
    upsert_metadata = build_upsert_mission_metadata(args=args)
    context_section = build_upsert_mission_context_section(metadata=upsert_metadata)
    context_message = build_upsert_mission_context_message(metadata=upsert_metadata)

    issue_body = summary
    if details:
        issue_body = f'{summary}\n\n{details}'
    if metadata:
        issue_body = f'{issue_body}\n\n{metadata}'
    if context_section:
        issue_body = f'{issue_body}\n\n{context_section}'

    document_body = build_mission_document_body(
        mission_id=mission_id,
        title=title,
        stage=stage,
        status=status,
        summary=summary,
        details=details,
        worker_update=channel_message,
        metadata=metadata,
        context_section=context_section,
    )

    channel_message_with_metadata = channel_message
    if args.append_channel_metadata:
        channel_metadata = [entry for entry in [channel_metadata_header, context_message] if entry]
        if channel_metadata:
            channel_message_with_metadata = f'{channel_message}\n\n' + '\n\n'.join(channel_metadata)
    issue_status = args.issue_status.strip() or derive_issue_status_for_mission_status(status)

    issue_result = create_or_update_issue(
        context=context,
        project_ref=args.project,
        title=title,
        body=issue_body,
        mission_id=mission_id,
        status=issue_status,
        priority=args.priority,
    )

    document_result = create_or_update_document(
        context=context,
        teamspace_ref=args.teamspace,
        title=title,
        body=document_body,
        mission_id=mission_id,
    )

    channel_result = post_channel_message(
        context=context,
        channel_ref=args.channel,
        message=channel_message_with_metadata,
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
        choices=[
            'http',
            'create-issue',
            'create-document',
            'post-channel-message',
            'list-channel-messages',
            'repair-teamspace-documents',
            'repair-project-issues',
            'dedupe-project-mission-issues',
            'upsert-mission',
            'account-info',
            'verify-chat-access',
        ],
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
    parser.add_argument(
        '--collaborator-url',
        default=env_first('HULY_COLLABORATOR_URL', 'HULY_COLLABORATOR_BASE_URL'),
        help='Override collaborator base URL (defaults to HULY_COLLABORATOR_URL or derived from base URL)',
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
    parser.add_argument(
        '--tracker-url',
        default=env_first('HULY_TRACKER_URL') or DEFAULT_TRACKER_URL,
        help='Tracker URL included in mission artifacts',
    )
    parser.add_argument('--swarm-name', default=env_first('SWARM_NAME'), help='Human-friendly swarm name for mission context')
    parser.add_argument(
        '--swarm-human-name',
        default=env_first('SWARM_HUMAN_NAME'),
        help='Human-readable operator name for mission context',
    )
    parser.add_argument(
        '--swarm-team-name',
        default=env_first('SWARM_TEAM_NAME'),
        help='Swarm team label for mission context',
    )

    # Artifact payload.
    parser.add_argument('--mission-id', default='', help='Mission id used for upsert and artifact titles')
    parser.add_argument('--title', default='', help='Artifact title')
    parser.add_argument('--body', default='', help='Body text for issue/document operations')
    parser.add_argument('--message', default='', help='Chat message body for post-channel-message')
    parser.add_argument(
        '--reply-to-message-id',
        default='',
        help='When set, post as a thread reply to this chat message id',
    )
    parser.add_argument(
        '--reply-to-message-class',
        default=CHAT_MESSAGE_CLASS,
        help='Class id for reply parent (defaults to chunter:class:ChatMessage)',
    )
    parser.add_argument('--summary', default='', help='Mission summary for upsert-mission')
    parser.add_argument('--details', default='', help='Mission details for upsert-mission')
    parser.add_argument('--stage', default='', help='Mission stage label for upsert-mission')
    parser.add_argument('--status', default='', help='Mission status label for upsert-mission')
    parser.add_argument(
        '--issue-status',
        default='',
        help='Issue status id for task artifacts (when omitted, updates keep current status and creates use project default)',
    )
    parser.add_argument('--priority', type=int, default=0, help='Issue priority for task artifacts')
    parser.add_argument(
        '--swarm-agent-worker-id',
        default='',
        help='Optional worker id metadata for mission provenance',
    )
    parser.add_argument(
        '--swarm-agent-identity',
        default='',
        help='Optional worker identity metadata for mission provenance',
    )
    parser.add_argument(
        '--append-channel-metadata',
        action='store_true',
        help='Append mission metadata/context to the channel message body (off by default for human-readable chat)',
    )
    parser.add_argument('--limit', type=int, default=20, help='Result limit for list-channel-messages')
    parser.add_argument(
        '--include-non-mission-docs',
        action='store_true',
        help='Include non-mission document titles for repair-teamspace-documents',
    )
    parser.add_argument(
        '--include-non-mission-issues',
        action='store_true',
        help='Include non-mission issue titles for repair-project-issues',
    )
    parser.add_argument(
        '--fill-empty-issue-descriptions',
        action='store_true',
        help='Backfill empty issue descriptions with a structured template during repair-project-issues',
    )
    parser.add_argument(
        '--dry-run',
        action='store_true',
        help='Report repair-teamspace-documents candidates without writing updates',
    )
    parser.add_argument(
        '--expected-actor-id',
        default='',
        help='When set, account-info fails unless current token resolves to this actor id',
    )
    parser.add_argument(
        '--expected-actor-env-key',
        default='',
        help='Env var key that contains expected actor id for this worker',
    )
    parser.add_argument(
        '--require-expected-actor-id',
        action='store_true',
        help='Fail account/chat verification when expected actor id is not configured',
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
        if args.operation == 'list-channel-messages':
            return run_list_channel_messages(args)
        if args.operation == 'repair-teamspace-documents':
            return run_repair_teamspace_documents(args)
        if args.operation == 'repair-project-issues':
            return run_repair_project_issues(args)
        if args.operation == 'dedupe-project-mission-issues':
            return run_dedupe_project_mission_issues(args)
        if args.operation == 'upsert-mission':
            return run_upsert_mission(args)
        if args.operation == 'account-info':
            return run_account_info(args)
        if args.operation == 'verify-chat-access':
            return run_verify_chat_access(args)
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
