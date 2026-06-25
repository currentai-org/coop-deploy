locals {
  org         = "currentai"
  domain      = "coop.publicai.co"

  region         = "eu-central-2"# "eu-central-2"
  s3state = "coop-terraform-state-${local.org}"
}
