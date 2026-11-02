#!/usr/bin/env python3
from __future__ import annotations

import os
import sys
from dataclasses import dataclass
from pathlib import Path


class PatchError(Exception):
    pass


@dataclass(frozen=True)
class AddFile:
    path: str
    lines: list[str]


@dataclass(frozen=True)
class DeleteFile:
    path: str


@dataclass(frozen=True)
class UpdateFile:
    path: str
    hunks: list[list[tuple[str, str]]]
    move_to: str | None = None


def fail(message: str) -> int:
    print(message, file=sys.stderr)
    return 1


def resolve_under_cwd(raw_path: str) -> Path:
    if not raw_path or "\0" in raw_path:
        raise PatchError("patch path is empty or invalid")
    candidate = Path(raw_path)
    if candidate.is_absolute():
        raise PatchError(f"patch path must be relative: {raw_path}")

    root = Path.cwd().resolve()
    resolved = (root / candidate).resolve()
    try:
        resolved.relative_to(root)
    except ValueError as exc:
        raise PatchError(f"patch path must stay under working directory: {raw_path}") from exc
    return resolved


def parse_section_path(line: str, marker: str) -> str:
    if not line.startswith(marker):
        raise PatchError(f"expected {marker}")
    path = line[len(marker) :].strip()
    if not path:
        raise PatchError(f"missing path after {marker}")
    return path


def is_file_section(line: str) -> bool:
    return line.startswith("*** Add File: ") or line.startswith("*** Update File: ") or line.startswith("*** Delete File: ")


def parse_patch(patch: str) -> list[AddFile | DeleteFile | UpdateFile]:
    normalized = patch.replace("\r\n", "\n").replace("\r", "\n")
    if not normalized.strip():
        raise PatchError("patch is empty")
    if not normalized.lstrip().startswith("*** Begin Patch"):
        raise PatchError("patch must start with *** Begin Patch")
    if not normalized.rstrip().endswith("*** End Patch"):
        raise PatchError("patch must end with *** End Patch")

    lines = normalized.split("\n")
    while lines and lines[-1] == "":
        lines.pop()
    if lines[0].strip() != "*** Begin Patch":
        raise PatchError("patch must start with *** Begin Patch")
    if lines[-1].strip() != "*** End Patch":
        raise PatchError("patch must end with *** End Patch")

    operations: list[AddFile | DeleteFile | UpdateFile] = []
    index = 1
    while index < len(lines) - 1:
        line = lines[index]
        if line.startswith("*** Add File: "):
            path = parse_section_path(line, "*** Add File: ")
            index += 1
            added: list[str] = []
            while index < len(lines) - 1 and not lines[index].startswith("*** "):
                entry = lines[index]
                if not entry.startswith("+"):
                    raise PatchError(f"add-file lines must start with '+': {entry}")
                added.append(entry[1:])
                index += 1
            operations.append(AddFile(path=path, lines=added))
            continue

        if line.startswith("*** Delete File: "):
            path = parse_section_path(line, "*** Delete File: ")
            operations.append(DeleteFile(path=path))
            index += 1
            continue

        if line.startswith("*** Update File: "):
            path = parse_section_path(line, "*** Update File: ")
            index += 1
            move_to: str | None = None
            if index < len(lines) - 1 and lines[index].startswith("*** Move to: "):
                move_to = parse_section_path(lines[index], "*** Move to: ")
                index += 1

            hunks: list[list[tuple[str, str]]] = []
            while index < len(lines) - 1 and not is_file_section(lines[index]):
                if lines[index] == "*** End of File":
                    index += 1
                    continue
                if lines[index].startswith("@@"):
                    index += 1

                hunk: list[tuple[str, str]] = []
                while index < len(lines) - 1 and not lines[index].startswith("@@") and not is_file_section(lines[index]):
                    entry = lines[index]
                    if entry == "*** End of File":
                        index += 1
                        break
                    if not entry:
                        raise PatchError("patch change lines must start with space, '+', or '-'")
                    prefix = entry[0]
                    if prefix not in {" ", "+", "-"}:
                        raise PatchError(f"unknown patch line prefix {prefix!r}: {entry}")
                    hunk.append((prefix, entry[1:]))
                    index += 1

                if hunk:
                    hunks.append(hunk)

            operations.append(UpdateFile(path=path, hunks=hunks, move_to=move_to))
            continue

        raise PatchError(f"unknown patch section: {line}")

    if not operations:
        raise PatchError("patch contains no file operations")
    return operations


def lines_to_text(lines: list[str]) -> str:
    return "".join(f"{line}\n" for line in lines)


def hunk_text(hunk: list[tuple[str, str]], prefixes: set[str]) -> str:
    return "".join(f"{line}\n" for prefix, line in hunk if prefix in prefixes)


def apply_update(path: Path, hunks: list[list[tuple[str, str]]]) -> str:
    if not path.exists():
        raise PatchError(f"file does not exist: {path}")
    original = path.read_text()
    updated = original
    cursor = 0
    for hunk in hunks:
        old = hunk_text(hunk, {" ", "-"})
        new = hunk_text(hunk, {" ", "+"})
        if old:
            location = updated.find(old, cursor)
            if location == -1:
                location = updated.find(old)
            if location == -1:
                raise PatchError(f"patch hunk did not match: {path}")
            updated = f"{updated[:location]}{new}{updated[location + len(old):]}"
            cursor = location + len(new)
        else:
            updated = f"{updated[:cursor]}{new}{updated[cursor:]}"
            cursor += len(new)
    return updated


def apply_operations(operations: list[AddFile | DeleteFile | UpdateFile]) -> list[str]:
    changed: list[str] = []
    for operation in operations:
        if isinstance(operation, AddFile):
            path = resolve_under_cwd(operation.path)
            if path.exists():
                raise PatchError(f"file already exists: {operation.path}")
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_text(lines_to_text(operation.lines))
            changed.append(operation.path)
            continue

        if isinstance(operation, DeleteFile):
            path = resolve_under_cwd(operation.path)
            if not path.exists():
                raise PatchError(f"file does not exist: {operation.path}")
            path.unlink()
            changed.append(operation.path)
            continue

        path = resolve_under_cwd(operation.path)
        updated = apply_update(path, operation.hunks) if operation.hunks else path.read_text()
        if operation.move_to:
            target = resolve_under_cwd(operation.move_to)
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_text(updated)
            if target != path and path.exists():
                path.unlink()
            changed.append(operation.move_to)
        else:
            path.write_text(updated)
            changed.append(operation.path)

    return changed


def main() -> int:
    try:
        patch = sys.stdin.read()
        changed = apply_operations(parse_patch(patch))
    except PatchError as exc:
        return fail(str(exc))
    except OSError as exc:
        return fail(f"patch failed: {exc}")

    for path in changed:
        print(f"changed {path}")
    return 0


if __name__ == "__main__":
    os.umask(0o022)
    raise SystemExit(main())
