"""Exercise the deployed schema runner against two real ClickHouse replicas."""

import json
import pathlib
import re
import subprocess
import sys
import tempfile
import time
import uuid

ROOT = pathlib.Path(__file__).resolve().parents[1]
JOB = ROOT / "signal-schema-job.yaml"
SERVER = re.search(r"^\s+image: (\S+)", JOB.read_text(), re.MULTILINE).group(1)
KEEPER = "mirror.gcr.io/clickhouse/clickhouse-keeper:26.8.2.7@sha256:0fbe266b275a23b53508a7a3dac2e6fe149d63cddf242897a5c5c3d7b5350568"
PREFIX = "torghut-schema-" + uuid.uuid4().hex[:12]
NAMES = [PREFIX + "-keeper", PREFIX + "-a", PREFIX + "-b"]


def docker(*args, check=True, timeout=120):
    try:
        return subprocess.run(
            ["docker", *args],
            capture_output=True,
            text=True,
            check=check,
            timeout=timeout,
        )
    except subprocess.CalledProcessError as error:
        print(error.stderr, file=sys.stderr, flush=True)
        raise


def query(host, sql):
    return docker(
        "exec",
        host,
        "clickhouse-client",
        "--user",
        "fixture",
        "--password",
        "fixture-password",
        "--multiquery",
        "--query",
        sql,
    ).stdout.strip()


def reconcile(check=True):
    result = docker(
        "exec",
        "-e",
        "CLICKHOUSE_USERNAME=fixture",
        "-e",
        "CLICKHOUSE_PASSWORD=fixture-password",
        NAMES[1],
        "bash",
        "/schema/reconcile.sh",
        NAMES[1],
        check=check,
        timeout=180,
    )
    if check:
        assert (
            "All Signal schemas verified on both ClickHouse replicas" in result.stdout
        ), result.stdout + result.stderr
    return result


def passed(name):
    print(json.dumps({"passed": name}), flush=True)


with tempfile.TemporaryDirectory(prefix=PREFIX) as directory:
    directory = pathlib.Path(directory)
    keeper = directory / "keeper.xml"
    keeper.write_text(f"""<clickhouse><logger><level>warning</level><console>true</console></logger>
<listen_host>0.0.0.0</listen_host><keeper_server><tcp_port>2181</tcp_port><server_id>0</server_id>
<log_storage_path>/tmp/keeper/log</log_storage_path><snapshot_storage_path>/tmp/keeper/snapshot</snapshot_storage_path>
<coordination_settings><force_sync>true</force_sync></coordination_settings><raft_configuration><server><id>0</id>
<hostname>{NAMES[0]}</hostname><port>9444</port></server></raft_configuration></keeper_server></clickhouse>""")
    docker("network", "create", PREFIX)
    try:
        docker(
            "run",
            "-d",
            "--name",
            NAMES[0],
            "--network",
            PREFIX,
            "--memory",
            "512m",
            "--cpus",
            "0.5",
            "--tmpfs",
            "/tmp:rw,size=512m",
            "--log-opt",
            "max-size=1m",
            "--log-opt",
            "max-file=2",
            "-v",
            f"{keeper}:/fixture.xml:ro",
            "--entrypoint",
            "/usr/bin/clickhouse-keeper",
            KEEPER,
            "--config-file=/fixture.xml",
        )
        keeper_deadline = time.monotonic() + 45
        while True:
            ready = docker(
                "exec",
                NAMES[0],
                "bash",
                "-c",
                "exec 3<>/dev/tcp/127.0.0.1/2181",
                check=False,
            )
            if ready.returncode == 0:
                break
            if time.monotonic() > keeper_deadline:
                raise RuntimeError(
                    docker("logs", "--tail", "80", NAMES[0]).stderr[-12000:]
                )
            time.sleep(1)
        for host in NAMES[1:]:
            config = directory / (host + ".xml")
            config.write_text(f"""<clickhouse><logger><level>warning</level><console>true</console></logger>
<listen_host>0.0.0.0</listen_host><max_server_memory_usage>1600000000</max_server_memory_usage>
<background_schedule_pool_size>16</background_schedule_pool_size><background_pool_size>4</background_pool_size>
<merge_tree><number_of_free_entries_in_pool_to_execute_mutation>2</number_of_free_entries_in_pool_to_execute_mutation>
<number_of_free_entries_in_pool_to_lower_max_size_of_merge>2</number_of_free_entries_in_pool_to_lower_max_size_of_merge>
<number_of_free_entries_in_pool_to_execute_optimize_entire_partition>2</number_of_free_entries_in_pool_to_execute_optimize_entire_partition></merge_tree>
<remote_servers><default><shard><internal_replication>true</internal_replication>
<replica><host>{NAMES[1]}</host><port>9000</port></replica><replica><host>{NAMES[2]}</host><port>9000</port></replica>
</shard></default></remote_servers><zookeeper><node><host>{NAMES[0]}</host><port>2181</port></node></zookeeper>
<macros><cluster>default</cluster><shard>0</shard><replica>{host}</replica></macros></clickhouse>""")
            docker(
                "run",
                "-d",
                "--name",
                host,
                "--network",
                PREFIX,
                "--memory",
                "2g",
                "--cpus",
                "1",
                "--tmpfs",
                "/var/lib/clickhouse:rw,size=256m",
                "--tmpfs",
                "/var/log/clickhouse-server:rw,size=32m",
                "--log-opt",
                "max-size=1m",
                "--log-opt",
                "max-file=2",
                "-e",
                "CLICKHOUSE_USER=fixture",
                "-e",
                "CLICKHOUSE_PASSWORD=fixture-password",
                "-e",
                "CLICKHOUSE_DEFAULT_ACCESS_MANAGEMENT=1",
                "-v",
                f"{config}:/etc/clickhouse-server/config.d/fixture.xml:ro",
                "-v",
                f"{ROOT / 'schema'}:/schema:ro",
                SERVER,
            )
        deadline = time.monotonic() + 90
        for host in NAMES[1:]:
            while True:
                try:
                    assert query(host, "SELECT 1") == "1"
                    break
                except (subprocess.CalledProcessError, AssertionError):
                    if time.monotonic() > deadline:
                        raise RuntimeError(docker("logs", host).stderr[-4000:])
                    time.sleep(1)
        reconcile()
        passed("empty cluster creates and validates every schema on both replicas")
        for host in NAMES[1:]:
            query(host, "SYSTEM FLUSH LOGS")
        cutoff = query(NAMES[1], "SELECT now64(6)")
        result = reconcile()
        assert "Applying " not in result.stdout
        for host in NAMES[1:]:
            query(host, "SYSTEM FLUSH LOGS")
            count = query(
                host,
                f"SELECT count() FROM system.query_log WHERE event_time_microseconds > toDateTime64('{cutoff}',6) AND startsWith(query_id,'torghut-schema-') AND query_kind IN ('Create','Alter','Insert')",
            )
            assert count == "0", count
        passed("repeat run performs no DDL or backfill")
        query(
            NAMES[2],
            "CREATE OR REPLACE VIEW signal.webull_research_events_v1 AS SELECT 1 AS broken",
        )
        result = reconcile()
        assert result.stdout.count("Applying ") == 1
        assert f"Applying intraday-bars on {NAMES[2]}" in result.stdout
        passed("drift on only the second replica is detected and repaired")

        source = (ROOT / "schema/intraday-bars.sql").read_text()
        select = source.split("SQL SECURITY DEFINER AS\n", 1)[1].split(";", 1)[0]
        query(
            NAMES[2],
            "CREATE OR REPLACE VIEW signal.webull_research_events_v1 SQL SECURITY INVOKER AS "
            + select,
        )
        result = reconcile()
        assert result.stdout.count("Applying ") == 1
        assert (
            query(
                NAMES[2],
                "SELECT definer FROM system.tables WHERE database='signal' AND name='webull_research_events_v1'",
            )
            == "fixture"
        )
        passed("view security and definer are restored with the source contract")
        query(
            NAMES[1],
            "INSERT INTO signal.historical_datasets_v1 VALUES (repeat('a',64),'retained','coverage','calendar',now64(3))",
        )
        query(NAMES[2], "SYSTEM SYNC REPLICA signal.historical_datasets_v1")
        query(NAMES[1], "DROP TABLE signal.historical_datasets_v1 SYNC")
        result = reconcile()
        assert result.stdout.count("Applying ") == 1
        query(NAMES[1], "SYSTEM SYNC REPLICA signal.historical_datasets_v1")
        assert (
            query(NAMES[1], "SELECT manifest FROM signal.historical_datasets_v1")
            == "retained"
        )
        passed("partial migration resumes and retains replicated data")
        query(
            NAMES[1],
            "ALTER TABLE signal.intraday_bars_1m_v2 DROP COLUMN event_ts_exact",
        )
        query(NAMES[2], "SYSTEM SYNC REPLICA signal.intraday_bars_1m_v2")
        reconcile()
        passed("missing precision column is restored")
        query(
            NAMES[1],
            "ALTER TABLE signal.historical_dataset_chunks_v1 ADD COLUMN unexpected String",
        )
        query(NAMES[2], "SYSTEM SYNC REPLICA signal.historical_dataset_chunks_v1")
        result = reconcile(check=False)
        assert (
            result.returncode != 0
            and "All Signal schemas verified" not in result.stdout
        )
        passed("unrepairable schema drift fails the rollout")
    except BaseException:
        for name in NAMES:
            result = docker("logs", "--tail", "15", name, check=False)
            print(name, result.stdout[-2000:], result.stderr[-2000:], file=sys.stderr)
        raise
    finally:
        for name in reversed(NAMES):
            docker("rm", "-f", "-v", name, check=False)
        docker("network", "rm", PREFIX, check=False)
