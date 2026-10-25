terraform {
  required_providers {
    tailscale = {
      source  = "tailscale/tailscale"
      version = "~> 0.22.0"
    }
  }
}

provider "tailscale" {
  tailnet = var.tailnet
  api_key = var.tailscale_api_key
}

locals {
  // Rendered ACL policy managed by this stack.
  tailnet_acl = templatefile("${path.module}/templates/policy.hujson.tmpl", {})

  global_dns_nameservers = toset(var.dns_nameservers)
  split_dns_nameservers = {
    for domain, nameservers in var.dns_split_nameservers :
    domain => toset(nameservers)
  }
}

resource "tailscale_acl" "tailnet" {
  acl = local.tailnet_acl
}

resource "tailscale_dns_configuration" "tailnet" {
  magic_dns          = true
  override_local_dns = var.override_local_dns

  dynamic "nameservers" {
    for_each = local.global_dns_nameservers

    content {
      address = nameservers.value
    }
  }

  dynamic "split_dns" {
    for_each = local.split_dns_nameservers

    content {
      domain = split_dns.key

      dynamic "nameservers" {
        for_each = split_dns.value

        content {
          address = nameservers.value
        }
      }
    }
  }
}

data "tailscale_devices" "all" {}

locals {
  subnet_router_devices = {
    for device in data.tailscale_devices.all.devices :
    device.hostname => device.id
    if length(device.hostname) > 0 && contains(coalesce(device.tags, []), "tag:k8s-subnet-router")
  }
}

resource "tailscale_device_subnet_routes" "subnet_routers" {
  for_each = local.subnet_router_devices

  device_id = each.value
  routes    = var.kubernetes_routes
}
