# The scratch stack names what it needs, not a provider (D-146). Throwaway: never a real project.
module "project" {
  source = "../../modules/project"

  name            = "pf-scratch-m0-7"
  deploy_target   = var.deploy_target
  target_settings = var.target_settings
  kv_stores       = ["store"]
  txt_records     = { "pf-scratch-m0-7" = var.txt_content }
}

output "kv_store_ids" {
  value = module.project.kv_store_ids
}

output "txt_record_ids" {
  value = module.project.txt_record_ids
}
