// The token-stripping helpers live with Bootstrap's protected scripts (D-358 lock 1, O-113);
// init-project strips the same variables before it starts nodrift init.
export {
  BOOTSTRAP_TOKEN_ENV_KEYS,
  envExposesBootstrapToken,
  envWithoutBootstrapTokens,
} from "../../.github/scripts/bootstrap-common.mjs";
