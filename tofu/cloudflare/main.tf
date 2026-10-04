terraform {
  required_providers {
    cloudflare = {
      source  = "cloudflare/cloudflare"
      version = "~> 5.0.0"
    }
  }
}


resource "cloudflare_zone" "proompteng_ai" {
  account = {
    id = "be9df9a506bebc73a77a44826de3ff6f"
  }
  name = "proompteng.ai"
  type = "full"
}
