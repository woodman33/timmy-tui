// R12: the pages of the rail beyond Chat, Models & accounts and Canvas (./chat.jsx, ./models.jsx, ./canvas.jsx: imported by
// ../app.jsx). Each page owns its own file here (UI-OWNERSHIP.md).
import { pending } from './pending.jsx';

export const PAGE_PARTS = {
  files: pending('files'),
  workflows: pending('workflows'),
  runs: pending('runs'),
  voxvision: pending('voxvision'),
  motion: pending('motion'),
  tools: pending('tools'),
  control: pending('control'),
  help: pending('help'),
  settings: pending('settings'),
};
