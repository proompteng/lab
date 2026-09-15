terraform {
  required_providers {
    rancher2 = {
      source  = "rancher/rancher2"
      version = ">= 4.1.0"
    }
  }

  backend "pg" {
    conn_str = "postgres://altra:@nuc.lan:5432/altra?sslmode=disable"
  }
}

provider "rancher2" {
  api_url   = "https://rancher.lan"
  bootstrap = true
  insecure = true
}

resource "rancher2_cluster_v2" "harvester" {
  name = "altra"
  kubernetes_version = "rke2-/k3s-version"
}
