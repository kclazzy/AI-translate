import { browserBackend, servePages, type PagePort } from '@ait/core';

/** A background thread for the pages' pixel work (see core pipeline/remote.ts and handler.ts). */
servePages(self as unknown as PagePort, browserBackend);
