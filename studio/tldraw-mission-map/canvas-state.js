// Browser-local checkpoints, separate from dispatch projections and execution.
export const CANVAS_FORMAT = 'timmy.canvas.v1';
export const MAX_CANVAS_BYTES = 8 * 1024 * 1024;
const object = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
export function canvasStorageKey(board) {
  if (!['blank', 'dispatch'].includes(board)) throw new Error('Unknown board.');
  return `timmy.canvas.v1.${board}`;
}
export function serializeCanvas(snapshot, board, now = new Date()) {
  const text = JSON.stringify({ format: CANVAS_FORMAT, board, savedAt: now.toISOString(), snapshot });
  parseCanvas(text, board);
  return text;
}
export function parseCanvas(text, board) {
  canvasStorageKey(board);
  if (typeof text !== 'string' || new TextEncoder().encode(text).length > MAX_CANVAS_BYTES) throw new Error('Canvas file exceeds the 8 MB limit.');
  const value = JSON.parse(text);
  if (!object(value) || value.format !== CANVAS_FORMAT || value.board !== board ||
      typeof value.savedAt !== 'string' || !Number.isFinite(Date.parse(value.savedAt)) ||
      !object(value.snapshot) || !object(value.snapshot.document) ||
      !object(value.snapshot.document.store) || !object(value.snapshot.document.schema)) {
    throw new Error('Invalid canvas file or different board.');
  }
  if (Object.keys(value.snapshot.document.store).length > 10_000) throw new Error('Canvas file contains too many records.');
  return value;
}
export function formatCanvasError(error) {
  const errors = error instanceof AggregateError ? error.errors : [error];
  return errors.map((item) => typeof item?.message === 'string' ? item.message : String(item)).join(' · ');
}
export function createCanvasCheckpoint({ board, storage, getSnapshot, loadSnapshot }) {
  const key = `${canvasStorageKey(board)}.checkpoint`;
  let recoverySnapshot = null;
  const getRecoverySnapshot = () => recoverySnapshot === null ? null : structuredClone(recoverySnapshot);
  const exportSnapshot = () => serializeCanvas(getSnapshot(), board);
  const save = () => {
    const text = exportSnapshot(); storage.setItem(key, text);
    return parseCanvas(text, board).savedAt;
  };
  const importSnapshot = (text, { replace = false } = {}) => {
    if (!replace) throw new Error('Replacing this board requires explicit confirmation.');
    const value = parseCanvas(text, board); const before = structuredClone(getSnapshot());
    try { loadSnapshot(structuredClone(value.snapshot)); }
    catch (importError) {
      // Keep the preimage private; a rollback dependency can mutate its input.
      recoverySnapshot = before;
      try { loadSnapshot(structuredClone(before)); }
      catch (rollbackError) {
        throw new AggregateError([importError, rollbackError],
          'Canvas import failed and restoring the prior board also failed.', { cause: importError });
      }
      throw importError;
    }
    return value.savedAt;
  };
  const restore = (options) => {
    const text = storage.getItem(key);
    if (text === null) throw new Error('No saved checkpoint for this board.');
    return importSnapshot(text, options);
  };
  return { save, restore, exportSnapshot, importSnapshot, getRecoverySnapshot };
}
