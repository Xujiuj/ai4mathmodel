const path = require('node:path');

// Only inert document formats may be handed to the operating system shell. Executable and
// script types stay excluded because generated Python can create arbitrary files under work/,
// and the renderer file tree lets the user click any of them.
const SHELL_OPENABLE_EXTENSIONS = new Set([
  '.pdf', '.png', '.jpg', '.jpeg', '.webp', '.gif', '.bmp',
  '.csv', '.xlsx', '.docx', '.txt', '.md', '.tex', '.bib', '.log', '.json', '.yaml', '.yml',
]);

// Renderer-driven writes are confined to the two user-owned trees. Without this the editor
// could overwrite checkpoint manifests or other internal state stored inside the project.
const WRITABLE_TOP_DIRECTORIES = new Set(['work', 'inputs']);

function isShellOpenable(target) {
  return SHELL_OPENABLE_EXTENSIONS.has(path.extname(String(target || '')).toLowerCase());
}

function relativeSegments(root, target) {
  return path.relative(root, target).replaceAll('\\', '/').split('/').filter(Boolean);
}

/**
 * Returns a human-readable reason when the target must not be written by the renderer,
 * or an empty string when the write is permitted.
 */
function writeRejectionReason(root, target) {
  const segments = relativeSegments(root, target);
  if (!segments.length) return '不能直接写入项目根目录。';
  if (!WRITABLE_TOP_DIRECTORIES.has(segments[0])) return '只能写入项目的 work 或 inputs 目录。';
  if (segments.some((segment) => segment.startsWith('.'))) return '不能写入项目的内部状态目录。';
  return '';
}

module.exports = {
  SHELL_OPENABLE_EXTENSIONS,
  WRITABLE_TOP_DIRECTORIES,
  isShellOpenable,
  relativeSegments,
  writeRejectionReason,
};
