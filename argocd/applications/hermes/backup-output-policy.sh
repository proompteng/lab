#!/bin/sh

# Hermes 0.20.6 creates a live Unix-domain socket at $HERMES_HOME/gateway.sock,
# but its full-backup walker does not exclude that transient runtime file. The
# backup remains complete when that exact socket is the only skipped path.
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
      backup_policy_socket="$backup_policy_home/gateway.sock"
      backup_policy_header='  Warnings (1 files skipped):'
      backup_policy_detail="  gateway.sock: [Errno 6] No such device or address: '$backup_policy_socket'"
      backup_policy_header_count=$(printf '%s\n' "$backup_policy_output" | grep -Fxc "$backup_policy_header" || :)
      backup_policy_detail_count=$(printf '%s\n' "$backup_policy_output" | grep -Fxc "$backup_policy_detail" || :)

      [ -S "$backup_policy_socket" ] || return 1
      [ "$backup_policy_header_count" -eq 1 ] || return 1
      [ "$backup_policy_detail_count" -eq 1 ] || return 1
      case "$backup_policy_output" in
        *"Backup incomplete:"*) ;;
        *) return 1 ;;
      esac
      case "$backup_policy_output" in
        *"Backup complete:"*) return 1 ;;
      esac
      ;;
  esac
)
