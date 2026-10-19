"use strict";

// Preserve ARM64 helper bytes while avoiding filters unsupported by NSIS.
module.exports = async function beforePack(context) {
  if (context.electronPlatformName === "win32") {
    process.env.ELECTRON_BUILDER_7Z_FILTER = "BCJ";
  }
};
