// Native-launcher preflight: importing config.ts exercises every source-level
// environment read and validation without opening a database or network socket.
// Run this under the exact --allow-env= list from the systemd ExecStart line.

import "../config.ts";

console.log("CONFIG LOADED OK");
