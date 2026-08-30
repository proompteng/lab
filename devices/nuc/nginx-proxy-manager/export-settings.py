#!/usr/bin/env python3
from __future__ import annotations

import json
import sqlite3
from pathlib import Path


ROOT = Path(__file__).resolve().parent
DB_PATH = ROOT / 'data' / 'database.sqlite'
OUTPUT_PATH = ROOT / 'settings-export.json'

JSON_COLUMNS = {
  'proxy_host': {'domain_names', 'meta', 'locations'},
  'redirection_host': {'domain_names', 'meta'},
  'stream': {'meta'},
  'access_list': {'satisfy_any', 'pass_auth'},
  'certificate': {'domain_names', 'meta'},
  'dead_host': {'domain_names', 'meta'},
  'setting': {'meta'},
  'user': {'roles'},
}

TABLES = [
  'proxy_host',
  'redirection_host',
  'stream',
  'access_list',
  'certificate',
  'dead_host',
  'setting',
  'user',
]


def maybe_decode(table: str, key: str, value: object) -> object:
  if value is None:
    return None

  if key not in JSON_COLUMNS.get(table, set()) or not isinstance(value, str):
    return value

  try:
    return json.loads(value)
  except json.JSONDecodeError:
    return value


def fetch_table(con: sqlite3.Connection, table: str) -> list[dict[str, object]]:
  columns = {row['name'] for row in con.execute(f'PRAGMA table_info({table})').fetchall()}
  where = ' WHERE is_deleted = 0 OR is_deleted IS NULL' if 'is_deleted' in columns else ''
  order_by = ' ORDER BY id' if 'id' in columns else ''
  rows = con.execute(f'SELECT * FROM {table}{where}{order_by}').fetchall()
  items: list[dict[str, object]] = []
  for row in rows:
    item = {}
    for key in row.keys():
      if key in {'is_deleted'}:
        continue
      if table == 'auth' and key == 'secret':
        continue
      item[key] = maybe_decode(table, key, row[key])
    items.append(item)
  return items


def main() -> None:
  con = sqlite3.connect(DB_PATH)
  con.row_factory = sqlite3.Row

  export = {
    'source': str(DB_PATH.relative_to(ROOT)),
    'tables': {table: fetch_table(con, table) for table in TABLES},
  }

  OUTPUT_PATH.write_text(json.dumps(export, indent=2, sort_keys=True) + '\n')


if __name__ == '__main__':
  main()
