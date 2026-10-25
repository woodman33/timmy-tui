// R12: a page of the rail this build has not drawn in the shell yet: it says so in words, and where the work is today (never a
// stand-in that looks like the feature).
import { Page } from '../shell.jsx';
import { Empty } from '../ui.jsx';

export function pending(id) {
  return function PendingPage() {
    return (
      <Page id={id}>
        <Empty>This page is not drawn in this build yet. Nothing on it is shown as working.</Empty>
      </Page>
    );
  };
}
