#!/bin/sh

# Hermes 0.21.1 runs as PID 1 and creates two transient Unix-domain sockets.
# Its full-backup walker includes both. Accept only their exact omission records
# after proving that the omitted paths are sockets and accounting for every warning.
# Everything else stays fail-closed.
hermes_backup_output_is_safe() (
  backup_policy_output=$1
  backup_policy_home=$2

  case "$backup_policy_output" in
    *"SQLite safe copy failed"*|*"Raw copy also failed"*)
      return 1
      ;;
  esac

  case "$backup_policy_output" in
    *"Backup incomplete:"*|*"Warnings ("*)
      case "$backup_policy_output" in
        *"Backup incomplete:"*) ;;
        *) return 1 ;;
      esac
      case "$backup_policy_output" in
        *"Backup complete:"*) return 1 ;;
      esac
      backup_policy_count=0
      backup_policy_details=''
      for backup_policy_path in gateway.sock state/gateway.loop-tick.1.sock; do
        backup_policy_socket="$backup_policy_home/$backup_policy_path"
        backup_policy_detail="  $backup_policy_path: [Errno 6] No such device or address: '$backup_policy_socket'"
        backup_policy_detail_count=$(printf '%s\n' "$backup_policy_output" | grep -Fxc "$backup_policy_detail" || :)
        [ "$backup_policy_detail_count" -ne 0 ] || continue
        [ "$backup_policy_detail_count" -eq 1 ] || return 1
        [ ! -L "$backup_policy_socket" ] || return 1
        [ -S "$backup_policy_socket" ] || return 1
        backup_policy_count=$((backup_policy_count + 1))
        backup_policy_details="$backup_policy_details
$backup_policy_detail"
      done
      case "$backup_policy_count" in
        1) backup_policy_header='  Warnings (1 files skipped):' ;;
        2) backup_policy_header='  Warnings (2 files skipped):' ;;
        *) return 1 ;;
      esac
      backup_policy_warnings=$(printf '%s\n' "$backup_policy_output" | sed -n '/^  Warnings (/,$p')
      [ "$backup_policy_warnings" = "$backup_policy_header$backup_policy_details" ] || return 1
      ;;
  esac
)
