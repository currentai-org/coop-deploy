locals {
  org         = "currentai"
  region         = "eu-central-2"# "eu-central-2"
  s3state = "coop-terraform-state-${local.org}"
}
