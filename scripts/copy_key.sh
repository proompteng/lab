#!/bin/bash

# Get the directory where the script is located
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

SSH_KEY="$HOME/.ssh/id_ed25519.pub"
KEY_TO_COPY="$HOME/.ssh/1password.pub"

# Check if the SSH key for connection exists
if [ ! -f "$SSH_KEY" ]; then
    echo "Error: SSH key for connection not found at $SSH_KEY"
    echo "Please ensure you have an Ed25519 key for SSH connection"
    exit 1
fi

# Check if the key to be copied exists
if [ ! -f "$KEY_TO_COPY" ]; then
    echo "Error: 1Password public key not found at $KEY_TO_COPY"
    exit 1
fi

# File containing list of remote hosts (one per line in format: user@hostname)
HOSTS_FILE="$SCRIPT_DIR/remote_hosts.txt"

if [ ! -f "$HOSTS_FILE" ]; then
    echo "Error: $HOSTS_FILE not found"
    echo "Please create $HOSTS_FILE with one host per line in format: user@hostname"
    exit 1
fi

# Read hosts into an array
mapfile -t HOSTS <"$HOSTS_FILE"
TOTAL_HOSTS=${#HOSTS[@]}
echo "Found $TOTAL_HOSTS hosts to process"

# Read the public key content that needs to be copied
if ! PUBLIC_KEY=$(cat "$KEY_TO_COPY"); then
    echo "Error: Failed to read public key from $KEY_TO_COPY"
    exit 1
fi

# Function to copy SSH key to remote host
copy_key() {
    local host=$1
    local host_num=$2
    echo "[$host_num/$TOTAL_HOSTS] Attempting to copy 1Password public key to $host..."

    # Test SSH connection first (using Ed25519 key)
    if ! ssh -i "$HOME/.ssh/id_ed25519" \
        -o PasswordAuthentication=no \
        -o StrictHostKeyChecking=accept-new \
        -o ConnectTimeout=10 \
        "$host" "echo 'Testing connection...'"; then
        echo "Error: Failed to establish SSH connection to $host"
        echo "Please check:"
        echo "  1. Host is reachable (ping $host)"
        echo "  2. SSH service is running on the remote host"
        echo "  3. Username and hostname are correct"
        echo "  4. Your Ed25519 key is already authorized on the remote host"
        return 1
    fi

    # Create .ssh directory if it doesn't exist and set permissions (using Ed25519 key)
    if ! ssh -i "$HOME/.ssh/id_ed25519" \
        -o StrictHostKeyChecking=accept-new \
        -o ConnectTimeout=10 \
        "$host" "mkdir -p ~/.ssh && chmod 700 ~/.ssh && \
                     echo '$PUBLIC_KEY' >> ~/.ssh/authorized_keys && \
                     chmod 600 ~/.ssh/authorized_keys"; then
        echo "Error: Failed to copy 1Password key to $host"
        echo "Please check:"
        echo "  1. You have correct SSH access with Ed25519 key"
        echo "  2. You have write permissions in remote ~/.ssh directory"
        echo "  3. Remote disk is not full"
        return 1
    fi

    echo "Successfully copied 1Password key to $host"
    return 0
}

# Process each host
SUCCESSFUL_HOSTS=0
FAILED_HOSTS=0

for ((i = 0; i < TOTAL_HOSTS; i++)); do
    host="${HOSTS[$i]}"
    # Skip empty lines and comments
    [[ -z "$host" || "$host" =~ ^[[:space:]]*# ]] && continue

    if copy_key "$host" "$((i + 1))"; then
        ((SUCCESSFUL_HOSTS++))
    else
        ((FAILED_HOSTS++))
        echo "Warning: Failed to process $host, continuing with next host..."
    fi
done

# Print summary
echo
echo "Summary:"
echo "Total hosts processed: $TOTAL_HOSTS"
echo "Successful: $SUCCESSFUL_HOSTS"
echo "Failed: $FAILED_HOSTS"

if [ "$FAILED_HOSTS" -gt 0 ]; then
    exit 1
fi
