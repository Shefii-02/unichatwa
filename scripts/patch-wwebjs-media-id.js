/**
 * Make whatsapp-web.js media sends work on current WhatsApp Web builds.
 *
 * Every media message (image, video, audio, document, voice) fails inside `Client.sendMessage`
 * while WhatsApp Web builds the outgoing `Msg`, reaching the caller as
 *
 *   Data passed to getter must include an id property (it's how we memoize) but got undefined
 *   s (https://static.whatsapp.net/rsrc.php/...)
 *
 * Plain text sends are unaffected. The cause is in `window.WWebJS.sendMessage`
 * (src/util/Injected/Utils.js): the outgoing message object is built as
 *
 *   { ...options, id: newMsgKey, ..., ...mediaOptions, ...mediaOptions.toJSON(), ... }
 *
 * `mediaOptions` is the media data MODEL returned by `processMediaData`, not a plain object. Spreading
 * it AFTER `id: newMsgKey` copies the model's own private id (`__x_id`) and its serialised `id` over
 * the real message key, so `Msg.initialize` -> `getValidatedSender()` later reads an id that is
 * undefined. The fix restores the message key after the spreads and drops the private id; it only
 * runs when the send actually carries media, so text sends keep the exact upstream path.
 *
 * The transform is exact and self-disabling: an unknown shape fails the build instead of silently
 * shipping without the fix, matching the sibling patchers.
 */
'use strict';

const fs = require('fs');
const path = require('path');

const DEFAULT_WWJS = path.join(__dirname, '..', 'node_modules', 'whatsapp-web.js');
const UTILS_PATH = path.join('src', 'util', 'Injected', 'Utils.js');

/** Upstream, byte-exact: the end of the outgoing message object and the line that follows it. */
const FIND = `            ...extraOptions,
        };

        // Bot's won't reply if canonicalUrl is set (linking)`;

const REPLACE = `            ...extraOptions,
        };

        // The media model spread above carries its own private id (__x_id / id). Left in place it
        // replaces the real message key, and WhatsApp Web then throws "Data passed to getter must
        // include an id property" while building the Msg. Restore the key for media sends only.
        if (Object.keys(mediaOptions).length > 0) {
            delete message.__x_id;
            message.id = newMsgKey;
        }

        // Bot's won't reply if canonicalUrl is set (linking)`;

function applyMediaIdPatch({ wwjsDir = DEFAULT_WWJS } = {}) {
  const file = path.join(wwjsDir, UTILS_PATH);
  if (!fs.existsSync(file)) {
    throw new Error(`whatsapp-web.js Utils.js not found at ${file}`);
  }
  const source = fs.readFileSync(file, 'utf8');
  if (source.includes(REPLACE)) {
    return { applied: [], skipped: ['media-id'] };
  }
  if (!source.includes(FIND)) {
    throw new Error(`unexpected sendMessage message-object shape in ${UTILS_PATH}: refusing to patch blind`);
  }
  fs.writeFileSync(file, source.replace(FIND, REPLACE));
  return { applied: ['media-id'], skipped: [] };
}

function run() {
  const bestEffort = process.argv.includes('--best-effort');
  try {
    const { applied, skipped } = applyMediaIdPatch();
    const report = [
      ...applied.map((name) => `applied ${name}`),
      ...skipped.map((name) => `skipped ${name} (already present)`),
    ].join('; ');
    console.log(`patch-wwebjs-media-id: ${report}`);
  } catch (error) {
    if (bestEffort) {
      console.warn(`patch-wwebjs-media-id: skipped, ${error.message}`);
      return;
    }
    console.error(`patch-wwebjs-media-id: ${error.message}`);
    process.exitCode = 1;
  }
}

if (require.main === module) run();

module.exports = { applyMediaIdPatch, FIND, REPLACE, UTILS_PATH };
