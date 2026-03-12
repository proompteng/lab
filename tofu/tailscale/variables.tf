variable "tailnet" {
  description = "Name of the tailnet to manage (use '-' for the API key's default)."
  type        = string
  default     = "-"
}

variable "dns_nameservers" {
  description = "Global nameservers used by tailnet devices when overriding local DNS settings."
  type        = list(string)
  default = [
    "192.168.1.130"
  ]
}

variable "override_local_dns" {
  description = "Whether to force tailnet devices to use the configured global nameservers for non-tailnet queries."
  type        = bool
  default     = true
}

variable "dns_split_nameservers" {
  description = "Per-domain split DNS nameservers. Keys are domains and values are the nameserver IPs for that domain."
  type        = map(list(string))
  default     = {}
}

variable "kubernetes_routes" {
  description = "Cluster networks advertised by tagged kube nodes. Include both pod and service CIDRs used by the cluster."
  type        = list(string)
  default = [
    "10.244.0.0/16",
    "10.96.0.0/12"
  ]
}

variable "tailscale_api_key" {
  description = "Optional API key used for the Tailscale provider; prefer supplying via environment variable."
  type        = string
  default     = null
  nullable    = true
  sensitive   = true
}
