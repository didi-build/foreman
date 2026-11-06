# The factory stack's reviewed settings for production (D-339, O-105). The Infra apply workflow
# plans with this file. A change here is a pull request Didi reviews, then a plan Didi reads and
# an apply Didi approves.
#
# No secret and no id goes here (ADR 0110 secrets rule 1): the tokens, the R2 key and the
# passphrase are the GitHub environment's secrets, and the Cloudflare account and zone ids and
# the receiver's host name are its variables (docs/runbooks/first-hosting.md, step 3).

# A version DigitalOcean lists as supported (1.37 on 2026-11-06, runbook step 1).
kubernetes_version_prefix = "1.37."

# The DNS gate (runbook step 11, D-195): true only once Didi approves the receiver's DNS record.
publish_receiver_dns = false

# The tunnel gate (runbook step 11a, D-271): true only once Didi approves the planning chat's
# paths on the receiver's tunnel.
expose_planning_route = false
