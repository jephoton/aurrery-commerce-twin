import { createClassifyHandler } from "../_lib/classify-handler";

/** POST handlers are never cached. A route file exports only HTTP methods, so the handler lives in `_lib`. */
export const POST = createClassifyHandler();
