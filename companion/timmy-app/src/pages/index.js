// R12: the pages of the rail beyond Chat, Models & accounts and Canvas (./chat.jsx, ./models.jsx, ./canvas.jsx: imported by
// ../app.jsx). Each page owns its own file here (UI-OWNERSHIP.md).
import { pending } from './pending.jsx';
import ToolsPage from './tools.jsx';
import HelpPage from './help.jsx';
import SettingsPage from './settings.jsx';
import VoxVisionPage from './voxvision.jsx';
import MotionPage from './motion.jsx';
import RunsPage from './runs.jsx';
import ControlPage from './control.jsx';
import FilesPage from './files.jsx';
import WorkflowsPage from './workflows.jsx';

export const PAGE_PARTS = {
  files: FilesPage,
  workflows: WorkflowsPage,
  runs: RunsPage,
  voxvision: VoxVisionPage,
  motion: MotionPage,
  tools: ToolsPage,
  control: ControlPage,
  help: HelpPage,
  settings: SettingsPage,
};
