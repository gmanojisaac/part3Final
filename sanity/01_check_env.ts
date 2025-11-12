// sanity/01_check_env.ts
import { log, baseUrl } from "./_utils";

log("BASE", baseUrl());
log("PAPERTRADE", process.env.PAPERTRADE ?? "(unset)");
log("ALLOW_LTP_SEED", process.env.ALLOW_LTP_SEED ?? "(unset)");
log("PORT", process.env.PORT ?? "(unset)");
